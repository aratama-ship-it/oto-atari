// ink.mjs — Intent → 「塗料が壁に当たる」描画。Canvas 2D のみ（Safari で無効な ctx.filter は使わない）。
// 塗料は paint レイヤーに蓄積し、haze の量に応じて背景色へ薄れていく。
import { zoneParts, verticalBand, horizontalBand } from "./zones.mjs";
import { hexToRgb } from "../lib/mapping-engine.mjs";

const TAU = Math.PI * 2;
function rnd(a, b) { return a + Math.random() * (b - a); }
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; }

export class InkRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.paint = document.createElement("canvas");
    this.pctx = this.paint.getContext("2d");
    this.drops = [];      // 落ちる滴 { x, y, vx, vy, r, color, life, weight }
    this.flashes = [];    // pulse { level, color, t0, decay, zone }
    this.strobes = [];    // { t0, dur, hz, duty, color, zone }
    this.sweeps = [];     // { t0, dur, from, to, color, width }
    this.blackouts = [];  // { t0, dur, fade }
    this.points = [];     // 同時発音する単音の光点
    this.pointMode = false;
    this.focus = false;
    this.surface = "#ece6da";
    this.fadePerSec = 0.35;
    this.lastT = null;
    this.resize();
  }
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h; this.paint.width = w; this.paint.height = h;
      this.pctx.fillStyle = this.surface; this.pctx.fillRect(0, 0, w, h);
    }
    this.w = w; this.h = h; this.dpr = dpr;
  }
  setSurface(hex) { if (hex && hex !== this.surface) { this.surface = hex; } }
  reset() { this.drops = []; this.flashes = []; this.strobes = []; this.sweeps = []; this.blackouts = []; this.points = []; this.pctx.fillStyle = this.surface; this.pctx.fillRect(0, 0, this.w, this.h); this.lastT = null; }

  /** 離散 Intent を受け取る（t は音源時刻）。 */
  receive(intent, nowT) {
    const { v, h } = zoneParts(intent.zone);
    switch (intent.intent) {
      case "point": this.points.push({ t0: intent.t, dur: intent.dur, x: intent.x, level: intent.level, color: intent.color || "#8fd4c9" }); break;
      case "splat": this.splat(intent, v, h); break;
      case "pulse": this.flashes.push({ level: intent.level ?? 0.3, color: intent.color || "#ffffff", t0: nowT, decay: intent.decaySec ?? 0.3, v, h }); break;
      case "strobe": this.strobes.push({ t0: nowT, dur: intent.dur ?? 0.5, hz: intent.hz ?? 8, duty: intent.duty ?? 0.5, color: intent.color || "#ffffff", v, h }); break;
      case "sweep": this.sweeps.push({ t0: nowT, dur: intent.dur ?? 2, from: zoneParts(intent.zone).v || "floor", to: zoneParts(intent.toZone).v || "air", color: intent.color || "#ffffff", width: intent.width ?? 0.25 }); break;
      case "blackout": this.blackouts.push({ t0: nowT, dur: intent.dur ?? 1, fade: intent.fadeSec ?? 0.1 }); break;
      default: break;
    }
  }

  splat(intent, v, h) {
    const [y0, y1] = verticalBand(v), [x0, x1] = horizontalBand(h);
    const size = intent.size ?? 0.5, weight = intent.weight ?? 0.5, spread = intent.spread ?? 0.5;
    // x（0=左 … 1=右）が指定されていればその位置へ。spread ぶんだけ横に散らす。無ければ横の zone 内でランダム
    const cx = (typeof intent.x === "number" ? Math.min(1, Math.max(0, intent.x + rnd(-0.06, 0.06) * spread)) : rnd(x0, x1)) * this.w;
    const cy = rnd(y0, y1) * this.h;
    const base = Math.min(this.w, this.h);
    const r = base * (0.02 + 0.16 * size) * (0.7 + 0.6 * weight);
    const color = intent.color || "#000000";
    const ctx = this.pctx;
    // 本体: 不揃いな輪郭の塊を数枚重ねる（塗料の「塊」）
    const lobes = 5 + Math.round(6 * size);
    ctx.fillStyle = rgba(color, 0.92);
    ctx.beginPath();
    for (let i = 0; i <= lobes; i++) {
      const a = (i / lobes) * TAU, rr = r * rnd(0.72, 1.12);
      const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr * (0.85 + 0.3 * weight);
      i === 0 ? ctx.moveTo(x, y) : ctx.quadraticCurveTo(cx + Math.cos(a - TAU / lobes / 2) * rr * 1.15, cy + Math.sin(a - TAU / lobes / 2) * rr * 1.15, x, y);
    }
    ctx.closePath(); ctx.fill();
    // 周囲の飛沫: 軽い音ほど遠く細かく散る
    const n = Math.round(6 + 26 * spread * (0.5 + size));
    for (let i = 0; i < n; i++) {
      const a = rnd(0, TAU), d = r * rnd(1.0, 1.6 + 2.6 * spread * (1.2 - weight));
      const pr = r * rnd(0.04, 0.22) * (1.2 - 0.6 * weight + 0.4 * spread);
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.9, pr, 0, TAU); ctx.fill();
    }
    // 重い塗料は垂れる。滴を粒子として持ち、毎フレーム描き足す
    const dripCount = Math.round(weight * weight * 6 * (0.5 + size));
    for (let i = 0; i < dripCount; i++) {
      this.drops.push({ x: cx + rnd(-r * 0.7, r * 0.7), y: cy + rnd(0, r * 0.6), vx: 0, vy: base * rnd(0.02, 0.08) * weight, r: r * rnd(0.05, 0.14), color, life: rnd(0.8, 2.5) * weight, weight });
    }
  }

  /** 毎フレーム: t=音源時刻, dt=秒, cont=連続 Intent の現在値, paletteSurface=現在の palette の surface 色 */
  frame(t, cont, paletteSurface) {
    this.resize();
    if (paletteSurface) this.setSurface(paletteSurface);
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(0.1, t - this.lastT));
    this.lastT = t;
    const { w, h } = this;
    const pctx = this.pctx, ctx = this.ctx;
    // haze: 蓄積した塗料が背景へ戻る速さ。haze 高い＝残像が長い（薄れにくい）
    const haze = cont.find((c) => c.intent === "haze");
    const hazeLevel = haze ? haze.level : 0.4;
    const fade = (1 - hazeLevel) * 1.2 * dt;  // 1秒あたりの戻り量
    if (fade > 0) { pctx.fillStyle = rgba(this.surface, Math.min(1, fade)); pctx.fillRect(0, 0, w, h); }
    // 滴
    for (const d of this.drops) {
      d.y += d.vy * dt; d.vy += (h * 0.15) * d.weight * dt; d.life -= dt;
      pctx.fillStyle = rgba(d.color, 0.85); pctx.beginPath(); pctx.ellipse(d.x, d.y, d.r * 0.8, d.r * 1.3, 0, 0, TAU); pctx.fill();
    }
    this.drops = this.drops.filter((d) => d.life > 0 && d.y < h + 10);

    // 合成: 塗料レイヤー → wash（帯の発光） → pulse → sweep → strobe → blackout
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.paint, 0, 0);
    ctx.globalCompositeOperation = "soft-light";
    for (const c of cont) {
      if (c.intent !== "wash" || c.level <= 0.01) continue;
      const { v, h: hz } = zoneParts(c.zone);
      const [y0, y1] = verticalBand(v), [x0, x1] = horizontalBand(hz);
      const grad = ctx.createLinearGradient(0, y0 * h, 0, y1 * h);
      grad.addColorStop(0, rgba(c.color || "#ffffff", 0)); grad.addColorStop(0.5, rgba(c.color || "#ffffff", Math.min(1, c.level * 1.2))); grad.addColorStop(1, rgba(c.color || "#ffffff", 0));
      ctx.fillStyle = grad; ctx.fillRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
    }
    ctx.globalCompositeOperation = "lighter";
    for (const f of this.flashes) {
      const age = t - f.t0; if (age < 0 || age > f.decay) continue;
      const a = f.level * (1 - age / f.decay);
      const [y0, y1] = verticalBand(f.v), [x0, x1] = horizontalBand(f.h);
      ctx.fillStyle = rgba(f.color, a * 0.6); ctx.fillRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h);
    }
    this.flashes = this.flashes.filter((f) => t - f.t0 <= f.decay);
    for (const s of this.sweeps) {
      const p = (t - s.t0) / s.dur; if (p < 0 || p > 1) continue;
      const [fy0, fy1] = verticalBand(s.from), [ty0, ty1] = verticalBand(s.to);
      const yc = ((fy0 + fy1) / 2) * (1 - p) + ((ty0 + ty1) / 2) * p;
      const half = s.width * 0.5;
      const grad = ctx.createLinearGradient(0, (yc - half) * h, 0, (yc + half) * h);
      grad.addColorStop(0, rgba(s.color, 0)); grad.addColorStop(0.5, rgba(s.color, 0.7)); grad.addColorStop(1, rgba(s.color, 0));
      ctx.fillStyle = grad; ctx.fillRect(0, (yc - half) * h, w, s.width * h);
    }
    this.sweeps = this.sweeps.filter((s) => t - s.t0 <= s.dur);
    ctx.globalCompositeOperation = "source-over";
    for (const s of this.strobes) {
      const age = t - s.t0; if (age < 0 || age > s.dur) continue;
      const phase = (age * s.hz) % 1;
      if (phase < s.duty) { const [y0, y1] = verticalBand(s.v), [x0, x1] = horizontalBand(s.h); ctx.fillStyle = rgba(s.color, 0.85); ctx.fillRect(x0 * w, y0 * h, (x1 - x0) * w, (y1 - y0) * h); }
    }
    this.strobes = this.strobes.filter((s) => t - s.t0 <= s.dur);
    for (const b of this.blackouts) {
      const age = t - b.t0; if (age < 0 || age > b.dur) continue;
      const a = Math.min(1, age / Math.max(0.001, b.fade), (b.dur - age) / Math.max(0.001, b.fade));
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, a)})`; ctx.fillRect(0, 0, w, h);
    }
    this.blackouts = this.blackouts.filter((b) => t - b.t0 <= b.dur);
    const pointY = h * (this.focus ? 0.54 : 0.82), pointX0 = w * 0.12, pointX1 = w * 0.88;
    if (this.focus && this.pointMode) {
      ctx.globalCompositeOperation = "source-over";
      ctx.strokeStyle = "rgba(143,212,201,0.28)"; ctx.lineWidth = this.dpr;
      ctx.beginPath(); ctx.moveTo(pointX0, pointY); ctx.lineTo(pointX1, pointY); ctx.stroke();
      ctx.fillStyle = "rgba(143,212,201,0.72)"; ctx.font = `${12 * this.dpr}px system-ui`;
      ctx.textBaseline = "bottom"; ctx.textAlign = "left"; ctx.fillText("低", pointX0, pointY - 14 * this.dpr);
      ctx.textAlign = "right"; ctx.fillText("高", pointX1, pointY - 14 * this.dpr);
    }
    if (this.points.length) {
      ctx.globalCompositeOperation = "lighter";
      for (const p of this.points) {
        const age = t - p.t0, tail = Math.max(0, age - p.dur);
        if (age < 0 || tail > 0.12) continue;
        const lv = Math.max(0, Math.min(1, p.level)) * (tail ? 1 - tail / 0.12 : 1);
        const x = pointX0 + Math.max(0, Math.min(1, p.x)) * (pointX1 - pointX0);
        const glowRadius = (this.focus ? 30 + 40 * lv : 16 + 16 * lv) * this.dpr;
        const glow = ctx.createRadialGradient(x, pointY, 0, x, pointY, glowRadius);
        glow.addColorStop(0, rgba(p.color, lv * 0.9)); glow.addColorStop(0.35, rgba(p.color, lv * 0.42)); glow.addColorStop(1, rgba(p.color, 0));
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, pointY, glowRadius, 0, TAU); ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      this.points = this.points.filter((p) => t <= p.t0 + p.dur + 0.12);
    }
  }
}
