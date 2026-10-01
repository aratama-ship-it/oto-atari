// rig.mjs — Intent → 照明図（正面から見た吊り物の簡略図）。zone を灯体グループへ翻訳して level/color/strobe を描く。
// γの light-design と同じグループ語彙（FL/SL/SH/WASH/CL/B1..B3/BACK/CY）を使い、γ書き出しの下敷きにもなる。
import { zoneParts, horizontalBand } from "./zones.mjs";
import { hexToRgb } from "../lib/mapping-engine.mjs";

export const ZONE_TO_GROUPS = {
  floor: ["FL"], low: ["SL", "SH"], mid: ["WASH", "CL"], high: ["B1", "B2", "B3"], air: ["BACK", "CY"], all: ["FL", "SL", "SH", "WASH", "CL", "B1", "B2", "B3", "BACK", "CY"],
};
// 図上の配置（正面図・比率）。row=上から、count=灯数
const LAYOUT = [
  { id: "CY", label: "ホリゾント", y: 0.06, count: 6, wide: true },
  { id: "BACK", label: "バック", y: 0.16, count: 8 },
  { id: "B3", label: "第3バトン", y: 0.27, count: 8 }, { id: "B2", label: "第2バトン", y: 0.36, count: 8 }, { id: "B1", label: "第1バトン", y: 0.45, count: 8 },
  { id: "WASH", label: "ウォッシュ", y: 0.56, count: 10 }, { id: "CL", label: "シーリング", y: 0.65, count: 6 },
  { id: "SL", label: "サイド(左)", y: 0.74, count: 3, side: "left" }, { id: "SH", label: "サイド(右)", y: 0.74, count: 3, side: "right" },
  { id: "FL", label: "フロア", y: 0.9, count: 8 },
];
function rgba(hex, a) { const [r, g, b] = hexToRgb(hex || "#ffffff"); return `rgba(${r},${g},${b},${a})`; }

export class RigRenderer {
  constructor(canvas) { this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.state = new Map(); this.strobes = []; this.blackouts = []; this.sweeps = []; this.points = []; this.pointMode = false; this.lastT = null; for (const g of LAYOUT) this.state.set(g.id, { level: 0, color: "#f2ead6", hold: 0, decay: 0.5, xRange: [0, 1] }); }
  reset() { for (const s of this.state.values()) { s.level = 0; s.hold = 0; } this.strobes = []; this.blackouts = []; this.sweeps = []; this.points = []; this.pointMode = false; this.lastT = null; }
  groupsFor(zone) { const { v, h, all } = zoneParts(zone); const ids = all ? ZONE_TO_GROUPS.all : (ZONE_TO_GROUPS[v] || ZONE_TO_GROUPS.all); return { ids, xRange: horizontalBand(h) }; }
  receive(intent, nowT) {
    const { ids, xRange } = this.groupsFor(intent.zone);
    switch (intent.intent) {
      case "point": this.points.push({ t0: intent.t, dur: intent.dur, x: intent.x, level: intent.level, color: intent.color || "#8fd4c9" }); this.pointMode = true; break;
      case "splat": case "pulse": {
        const level = intent.intent === "splat" ? (intent.size ?? 0.5) : (intent.level ?? 0.3);
        for (const id of ids) { const s = this.state.get(id); if (!s) continue; s.hold = Math.max(s.hold, level); s.decay = intent.decaySec ?? 0.4; s.color = intent.color || s.color; s.xRange = xRange; }
        break;
      }
      case "strobe": this.strobes.push({ t0: nowT, dur: intent.dur ?? 0.5, hz: intent.hz ?? 8, duty: intent.duty ?? 0.5, color: intent.color || "#ffffff", ids }); break;
      case "sweep": this.sweeps.push({ t0: nowT, dur: intent.dur ?? 2, from: zoneParts(intent.zone).v || "floor", to: zoneParts(intent.toZone).v || "air", color: intent.color || "#ffffff" }); break;
      case "blackout": this.blackouts.push({ t0: nowT, dur: intent.dur ?? 1, fade: intent.fadeSec ?? 0.1 }); break;
      default: break;
    }
  }
  /** 現在のグループ別出力（γ書き出しでも使う）: Map id → {level 0..1, color, strobe|null} */
  snapshot(t, cont) {
    const out = new Map();
    for (const g of LAYOUT) {
      const s = this.state.get(g.id);
      let level = s.hold, color = s.color;
      for (const c of cont) { if (c.intent !== "wash") continue; const { ids } = this.groupsFor(c.zone); if (ids.includes(g.id) && c.level > level) { level = c.level; color = c.color || color; } }
      let strobe = null;
      for (const st of this.strobes) { const age = t - st.t0; if (age >= 0 && age <= st.dur && st.ids.includes(g.id)) { strobe = st; if (((age * st.hz) % 1) < st.duty) { level = Math.max(level, 1); color = st.color; } else level = Math.min(level, 0.05); } }
      for (const sw of this.sweeps) { const p = (t - sw.t0) / sw.dur; if (p < 0 || p > 1) continue; const order = ["floor", "low", "mid", "high", "air"]; const zi = order.findIndex((z) => (ZONE_TO_GROUPS[z] || []).includes(g.id)); const fi = order.indexOf(sw.from), ti = order.indexOf(sw.to); const pos = fi + (ti - fi) * p; const d = Math.abs(zi - pos); if (d < 1) { level = Math.max(level, 1 - d); color = sw.color; } }
      let black = 0;
      for (const b of this.blackouts) { const age = t - b.t0; if (age >= 0 && age <= b.dur) black = Math.max(black, Math.min(1, age / Math.max(0.001, b.fade), (b.dur - age) / Math.max(0.001, b.fade))); }
      level *= (1 - black);
      out.set(g.id, { level: Math.max(0, Math.min(1, level)), color, strobe: strobe ? { hz: strobe.hz, duty: strobe.duty } : null, xRange: s.xRange });
    }
    return out;
  }
  frame(t, cont) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.floor(this.canvas.clientWidth * dpr), h = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    const dt = this.lastT === null ? 0 : Math.max(0, Math.min(0.1, t - this.lastT)); this.lastT = t;
    for (const s of this.state.values()) if (s.hold > 0) s.hold = Math.max(0, s.hold - dt / Math.max(0.05, s.decay));
    const snap = this.snapshot(t, cont);
    const ctx = this.ctx;
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#0b0b0d"; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "rgba(255,255,255,0.12)"; ctx.lineWidth = 1 * dpr;
    ctx.font = `${11 * dpr}px system-ui, sans-serif`; ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.textBaseline = "middle";
    for (const g of LAYOUT) {
      const y = g.y * h;
      let x0 = 0.12 * w, x1 = 0.88 * w;
      if (g.side === "left") { x0 = 0.02 * w; x1 = 0.09 * w; } else if (g.side === "right") { x0 = 0.91 * w; x1 = 0.98 * w; }
      if (!g.side) { ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.textAlign = "right"; ctx.fillText(g.label, x0 - 6 * dpr, y); }
      else { ctx.fillStyle = "rgba(255,255,255,0.45)"; ctx.textAlign = "center"; ctx.fillText(g.side === "left" ? "SL" : "SH", (x0 + x1) / 2, y - 22 * dpr); }
      const st = snap.get(g.id);
      const r = Math.max(3, Math.min(9, (x1 - x0) / g.count * 0.28)) * dpr;
      for (let i = 0; i < g.count; i++) {
        const fx = g.side ? (x0 + x1) / 2 : x0 + ((i + 0.5) / g.count) * (x1 - x0);
        const fy = g.side ? y + (i - (g.count - 1) / 2) * 26 * dpr : y;
        const within = g.side || (((i + 0.5) / g.count) >= st.xRange[0] && ((i + 0.5) / g.count) <= st.xRange[1]);
        const lv = within ? st.level : st.level * 0.15;
        ctx.fillStyle = "rgba(255,255,255,0.08)"; ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.fill();
        if (lv > 0.01) {
          ctx.globalCompositeOperation = "lighter";
          const glow = ctx.createRadialGradient(fx, fy, 0, fx, fy, r * (2 + 6 * lv));
          glow.addColorStop(0, rgba(st.color, 0.9 * lv)); glow.addColorStop(0.4, rgba(st.color, 0.35 * lv)); glow.addColorStop(1, rgba(st.color, 0));
          ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(fx, fy, r * (2 + 6 * lv), 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = rgba(st.color, lv); ctx.beginPath(); ctx.arc(fx, fy, r, 0, Math.PI * 2); ctx.fill();
          ctx.globalCompositeOperation = "source-over";
        }
      }
      // 右端に数値（レベル％）
      if (!g.side) { ctx.textAlign = "left"; ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.fillText(`${Math.round(st.level * 100)}%${st.strobe ? ` ⚡${st.strobe.hz}Hz` : ""}`, x1 + 8 * dpr, y); }
    }
    if (this.pointMode) {
      const y = 0.82 * h, x0 = 0.12 * w, x1 = 0.88 * w;
      ctx.strokeStyle = "rgba(143,212,201,0.35)"; ctx.lineWidth = dpr;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
      ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.font = `${11 * dpr}px system-ui`;
      ctx.fillStyle = "#8fd4c9"; ctx.fillText("低", x0, y - 15 * dpr); ctx.fillText("高", x1, y - 15 * dpr);
      for (const p of this.points) {
        const age = t - p.t0, tail = Math.max(0, age - p.dur);
        if (age < 0 || tail > 0.12) continue;
        const lv = Math.max(0, Math.min(1, p.level)) * (tail ? 1 - tail / 0.12 : 1);
        const x = x0 + Math.max(0, Math.min(1, p.x)) * (x1 - x0);
        const glowRadius = (16 + 16 * lv) * dpr;
        ctx.globalCompositeOperation = "lighter";
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
        glow.addColorStop(0, rgba(p.color, lv * 0.9)); glow.addColorStop(0.35, rgba(p.color, lv * 0.42)); glow.addColorStop(1, rgba(p.color, 0));
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, glowRadius, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = "source-over";
      }
      this.points = this.points.filter((p) => t <= p.t0 + p.dur + 0.12);
    }
    this.strobes = this.strobes.filter((s) => t - s.t0 <= s.dur);
    this.sweeps = this.sweeps.filter((s) => t - s.t0 <= s.dur);
    this.blackouts = this.blackouts.filter((b) => t - b.t0 <= b.dur);
  }
}
export { LAYOUT as RIG_LAYOUT };
