// experience.mjs — 「体験」表示。音源時刻 t に該当する Intent を引いて、その瞬間の絵を直接描く（時刻決定型）。
// ink/rig のような受信蓄積型ではないので、停止・シーク・再開でも同じ絵になる。
// 表現と数値は docs/experience-compare-20260929/（10秒試作）で本人と8回調整したものを本体へ移植した。
// 数値の正本は design/TOKEN_SHEET.md §11（試作の TOKEN_SHEET.md と同値）。Canvas 2D のみ（Safari で無効な ctx.filter は使わない）。

const DRUM_TAGS = ["kick", "snare", "hat"];
const DRUM_WINDOW = { kick: 0.22, snare: 0.32, hat: 0.42 };
const DROP_WINDOW = 1.1;
const POINT_RELEASE = 0.5;
const SAME_HIT_SEC = 0.01;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rgba = (r, g, b, a) => `rgba(${r},${g},${b},${clamp(a, 0, 1)})`;

const LED_COUNT = 20;
const LED_TOL = 0.07;      // 拍の中の位置の許容（±0.07拍＝120BPMで±35ms）
const LED_MIN_FIT = 0.8;   // 小節内の打点の80%以上が格子に乗れば採用

/** 昇順の拍列 beats（{t}）に対する時刻 t の「拍の中の位置」0〜1 と拍番号。拍が無ければ null。 */
export function beatPhase(t, beats) {
  if (!beats || beats.length < 2) return null;
  let lo = 0, hi = beats.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (beats[mid].t <= t) lo = mid; else hi = mid - 1; }
  const b0 = beats[lo].t, b1 = lo + 1 < beats.length ? beats[lo + 1].t : b0 + (beats[lo].t - beats[lo - 1].t);
  if (b1 <= b0) return null;
  return { phase: (t - b0) / (b1 - b0), beat: lo };
}

/**
 * ハイハット打点列を小節ごとに見て、刻み N（2=8分／3=3連／4=16分）を先読みで決め、各打点にスロットを振る（純粋関数・テスト対象）。
 * beats は {t, beatInBar} の昇順配列。戻り値 { bars:[{start,end,N,fit,count}], hits:[{t,phase,N,slot,bar}] }。
 */
export function classifyHatPatterns(hatTimes, beats, { tol = LED_TOL, minFit = LED_MIN_FIT } = {}) {
  const times = hatTimes.slice().sort((a, b) => a - b);
  if (!beats || beats.length < 2) return { bars: [], hits: times.map((t, i) => ({ t, phase: null, N: null, slot: i % LED_COUNT, bar: -1 })) };
  const starts = beats.filter((b) => b.beatInBar === 0).map((b) => b.t);
  if (starts.length === 0) starts.push(beats[0].t);
  if (starts[0] > beats[0].t) starts.unshift(beats[0].t);
  const last = beats[beats.length - 1].t + (beats[beats.length - 1].t - beats[beats.length - 2].t);
  const bars = starts.map((start, i) => ({ start, end: i + 1 < starts.length ? starts[i + 1] : Math.max(last, start + 1e-3), N: null, fit: 0, count: 0 }));
  const dist = (phase, N) => { let best = 1; for (let k = 0; k <= N; k++) best = Math.min(best, Math.abs(phase - k / N)); return best; };
  const hits = times.map((t) => { const bp = beatPhase(t, beats); return { t, phase: bp ? bp.phase : null, N: null, slot: 0, bar: -1 }; });
  let bi = 0, prevN = 2;
  for (const bar of bars) {
    const inBar = [];
    while (bi < hits.length && hits[bi].t < bar.end) { if (hits[bi].t >= bar.start) { hits[bi].bar = bars.indexOf(bar); inBar.push(hits[bi]); } bi++; }
    bar.count = inBar.length;
    if (inBar.length === 0) { bar.N = prevN; continue; }
    let chosen = null, bestN = 2, bestFit = -1;
    for (const N of [2, 3, 4]) {
      const fit = inBar.filter((h) => h.phase !== null && dist(h.phase, N) <= tol).length / inBar.length;
      if (fit > bestFit) { bestFit = fit; bestN = N; }
      if (chosen === null && fit >= minFit) chosen = N;
    }
    bar.N = chosen ?? bestN; bar.fit = chosen !== null ? inBar.filter((h) => h.phase !== null && dist(h.phase, chosen) <= tol).length / inBar.length : bestFit;
    prevN = bar.N;
    for (const h of inBar) { h.N = bar.N; h.slot = h.phase === null ? 0 : Math.round(h.phase * bar.N) % bar.N; }
  }
  return { bars, hits };
}

/** スロット→光るバー番号の配列。layout: "interleave"（i mod N）／"block"（N区画）。mirror で左右反転。 */
export function ledBarsForSlot(slot, N, { count = LED_COUNT, layout = "interleave", mirror = false } = {}) {
  const out = [];
  if (!N || N < 1) return out;
  if (layout === "block") { const a = Math.floor(slot * count / N), b = Math.floor((slot + 1) * count / N); for (let i = a; i < b; i++) out.push(i); }
  else for (let i = 0; i < count; i++) if (i % N === slot) out.push(i);
  return mirror ? out.map((i) => count - 1 - i) : out;
}

/**
 * 離散 Intent と Feature Timeline の events から、体験表示が使う形へまとめる（純粋関数・テスト対象）。
 * - 打楽器は srcTag で判定し、同じ楽器の 10ms 以内の打点は 1 回にまとめる（splat＋pulse の二重発火対策）。
 * - ピアノは intent:"point"。無音と戻り（drop）は events から読む。
 */
export function collectExperienceData(discrete = [], events = [], { beats = null, sections = [] } = {}) {
  const sorted = discrete.slice().sort((a, b) => a.t - b.t);
  const hits = [], points = [];
  const lastByTag = {};
  let maxDur = 0;
  for (const d of sorted) {
    if (d.intent === "point") {
      const dur = Math.max(0, d.dur || 0);
      maxDur = Math.max(maxDur, dur);
      points.push({ t: d.t, dur, x: clamp(typeof d.x === "number" ? d.x : 0.5, 0, 1), level: clamp(d.level || 0.4, 0, 1), pitch: d.srcPitchMidi });
    } else if (DRUM_TAGS.includes(d.srcTag)) {
      const last = lastByTag[d.srcTag];
      if (last !== undefined && d.t - last <= SAME_HIT_SEC) continue;
      lastByTag[d.srcTag] = d.t;
      hits.push({ t: d.t, tag: d.srcTag, level: clamp(d.srcStrength ?? d.size ?? 0.5, 0.2, 1), x: typeof d.x === "number" ? d.x : 0.5 });
    }
  }
  // ハットの LED 割当: 小節ごとの刻み N を先読みで決め、表／裏／3連／16分のスロットをバー番号へ写す
  const hatHits = hits.filter((h) => h.tag === "hat");
  const usable = beats && beats.length >= 2;
  const cls = classifyHatPatterns(hatHits.map((h) => h.t), usable ? beats : null);
  const sectionIndexAt = (t) => { let k = 0; for (let i = 0; i < sections.length; i++) if (sections[i].start <= t) k = i; return k; };
  hatHits.forEach((h, i) => {
    const c = cls.hits[i];
    h.N = c.N; h.slot = c.slot; h.phase = c.phase;
    h.leds = c.N ? ledBarsForSlot(c.slot, c.N, { layout: c.N === 4 ? "block" : "interleave", mirror: sectionIndexAt(h.t) % 2 === 1 }) : [c.slot % LED_COUNT];
  });
  const cues = events.filter((e) => e.type === "drop" || e.type === "silence").map((e) => ({ t: e.t, type: e.type, dur: e.dur || 0, strength: e.strength ?? 1 })).sort((a, b) => a.t - b.t);
  return { hits, points, cues, maxDur, mode: points.length ? "piano" : "drums", ledBars: cls.bars, ledFallback: !usable };
}

/** 昇順配列 arr で arr[i].t >= t となる最初の i。 */
function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t) lo = mid + 1; else hi = mid; }
  return lo;
}

// すべてのテクスチャ位置はイベントから決める（停止・シークで絵が変わらない）
const grain = (seed) => { const n = Math.sin(seed * 127.1 + 19.19) * 43758.5453; return n - Math.floor(n); };

function haze(ctx, x, y, rx, ry, color, opacity) {
  if (rx <= 0 || ry <= 0 || opacity <= 0) return;
  ctx.save(); ctx.translate(x, y); ctx.scale(1, ry / rx);
  const light = ctx.createRadialGradient(0, 0, 0, 0, 0, rx);
  light.addColorStop(0, rgba(...color, opacity));
  light.addColorStop(0.22, rgba(...color, opacity * 0.69));
  light.addColorStop(0.56, rgba(...color, opacity * 0.20));
  light.addColorStop(1, rgba(...color, 0));
  ctx.fillStyle = light; ctx.fillRect(-rx, -rx, rx * 2, rx * 2);
  ctx.restore();
}

function motes(ctx, x, y, count, seed, rx, ry, progress, opacity, color, streak, reduced) {
  for (let i = 0; i < count; i++) {
    const theta = grain(seed + i * 5.3) * Math.PI * 2;
    const radius = Math.sqrt(grain(seed + i * 6.7 + 31));
    const drift = reduced ? 0 : progress;
    const px = x + Math.cos(theta) * radius * rx * (0.42 + 0.58 * drift);
    const py = y + Math.sin(theta) * radius * ry * (0.42 + 0.58 * drift);
    const alpha = opacity * (0.22 + 0.78 * grain(seed + i * 9.1 + 71));
    const length = streak ? 2 + 7 * grain(seed + i * 3.4 + 13) : 0.6 + 1.2 * grain(seed + i * 2.9 + 17);
    ctx.strokeStyle = rgba(...color, alpha); ctx.lineWidth = streak ? 0.55 : 1;
    ctx.beginPath(); ctx.moveTo(px, py);
    ctx.lineTo(px + (streak ? length * 0.54 : length), py - (streak ? length : 0));
    ctx.stroke();
  }
}

function brokenWave(ctx, x, y, rx, ry, seed, opacity, color, width) {
  for (let part = 0; part < 4; part++) {
    const first = Math.PI + part * Math.PI / 4 + 0.055;
    const last = first + Math.PI / 4 - 0.13 - 0.06 * grain(seed + part);
    ctx.strokeStyle = rgba(...color, opacity * (0.55 + 0.45 * grain(seed + part * 7)));
    ctx.lineWidth = width * (0.65 + 0.55 * grain(seed + part * 11));
    ctx.beginPath();
    for (let step = 0; step <= 12; step++) {
      const a = first + (last - first) * step / 12;
      const uneven = 1 + 0.024 * Math.sin(a * 13 + seed) + 0.014 * Math.sin(a * 29 + part);
      const px = x + Math.cos(a) * rx * uneven, py = y + Math.sin(a) * ry * uneven;
      if (step === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
}

function scatteredAir(ctx, x, y, count, seed, reachX, reachY, progress, opacity, color, reduced) {
  for (let i = 0; i < count; i++) {
    const angle = grain(seed + i * 4.31) * Math.PI * 2;
    const distance = Math.sqrt(grain(seed + i * 9.47 + 21));
    const spread = reduced ? 0.72 : 0.48 + progress * 0.65;
    const px = x + Math.cos(angle) * distance * reachX * spread;
    const py = y + Math.sin(angle) * distance * reachY * spread - progress * reachY * 0.12;
    const rx = reachX * (0.08 + 0.12 * grain(seed + i * 2.17 + 8));
    const ry = reachY * (0.14 + 0.18 * grain(seed + i * 3.91 + 15));
    haze(ctx, px, py, rx, ry, color, opacity * (0.42 + 0.58 * grain(seed + i * 5.13 + 38)));
  }
}

function goldenRing(ctx, x, y, radius, seed, opacity) {
  ctx.beginPath();
  for (let i = 0; i <= 120; i++) {
    const angle = i / 120 * Math.PI * 2;
    const tooth = 2 / Math.PI * Math.asin(Math.sin(angle * 18 + seed));
    const r = radius * (1 + 0.032 * tooth + 0.01 * Math.sin(angle * 29 + seed * 0.37));
    const px = x + Math.cos(angle) * r, py = y + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath(); ctx.lineJoin = "bevel";
  for (const [width, alpha, color] of [[11, 0.10, [245, 168, 62]], [3.2, 0.59, [255, 192, 78]], [1.1, 0.88, [255, 232, 151]]]) {
    ctx.strokeStyle = rgba(...color, alpha * opacity);
    ctx.lineWidth = width; ctx.stroke();
  }
}

function lightning(ctx, w, h, seed, shift, opacity, level) {
  const short = Math.min(w, h);
  const start = { x: w * 0.07, y: h * 0.78 + shift };
  const end = { x: w * 0.93, y: h * 0.22 + shift };
  const dx = end.x - start.x, dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const alongX = dx / length, alongY = dy / length;
  const normalX = dy / length, normalY = -dx / length;
  const points = [];
  for (let i = 0; i <= 20; i++) {
    const t = i / 20;
    const offset = i === 0 || i === 20 ? 0 : (grain(seed + i * 19.31) * 2 - 1) * short * 0.065 * (0.35 + 0.65 * grain(seed + i * 5.47 + 3));
    points.push({ x: start.x + dx * t + normalX * offset, y: start.y + dy * t + normalY * offset });
  }
  const stroke = (route, width, alpha, color) => {
    ctx.beginPath();
    route.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
    ctx.lineWidth = width; ctx.strokeStyle = rgba(...color, alpha * opacity); ctx.stroke();
  };
  const segments = (route, baseWidth, alpha, color, taper = false) => {
    for (let i = 0; i < route.length - 1; i++) {
      const width = taper ? baseWidth * (1 - 0.70 * i / (route.length - 1)) : baseWidth * (0.70 + 0.58 * grain(seed + i * 7.17 + 40));
      ctx.beginPath(); ctx.moveTo(route[i].x, route[i].y); ctx.lineTo(route[i + 1].x, route[i + 1].y);
      ctx.lineWidth = width * (0.8 + 0.2 * level);
      ctx.strokeStyle = rgba(...color, alpha * opacity); ctx.stroke();
    }
  };
  ctx.save(); ctx.lineCap = "round"; ctx.lineJoin = "miter";
  for (const index of [3, 6, 9, 14, 17]) {
    const root = points[index];
    const direction = grain(seed + index * 3.77) < 0.5 ? -1 : 1;
    const reach = short * (0.13 + 0.12 * grain(seed + index * 9.41));
    const branchX = normalX * direction + alongX * 0.34;
    const branchY = normalY * direction + alongY * 0.34;
    const branch = [root];
    for (let step = 1; step <= 4; step++) {
      const t = step / 4;
      const jitter = (grain(seed + index * 17 + step * 11.3) * 2 - 1) * short * 0.045;
      branch.push({ x: root.x + branchX * reach * t - branchY * jitter, y: root.y + branchY * reach * t + branchX * jitter });
    }
    stroke(branch, 8, 0.15, [242, 91, 35]);
    segments(branch, 2.2, 0.75, [255, 126, 48], true);
    segments(branch, 0.85, 0.90, [255, 225, 172], true);
  }
  stroke(points, 14, 0.20, [235, 81, 30]);
  segments(points, 3.3, 0.97, [255, 117, 43]);
  segments(points, 1.15, 1, [255, 233, 192]);
  ctx.restore();
}

export class ExperienceRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.data = null;
    this.reduce = false; // 「動きを抑える」チェック
    this.hatStyle = "bars"; // "bars"=上辺のLEDバー列（既定）／"ring"=中央の金色の瞬き
    this.media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.w = 1; this.h = 1;
  }
  get reduced() { return this.reduce || !!(this.media && this.media.matches); }
  setData(discrete, events, opts) { this.data = collectExperienceData(discrete, events, opts); }
  reset() { this.data = null; }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width)), height = Math.max(1, Math.round(rect.height));
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) { this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr); }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.w = width; this.h = height;
  }

  /** 音源時刻 t の絵を描く。playing は「再生すると…」の案内の出し分けにだけ使う。 */
  frame(t, { playing = false } = {}) {
    this.resize();
    const ctx = this.ctx, w = this.w, h = this.h, data = this.data;
    ctx.clearRect(0, 0, w, h);
    if (!data) { this.background("drums", false); this.hint("音源と割り振りを読み込むと、ここに体験表示が出ます"); return; }
    const silence = data.cues.some((c) => c.type === "silence" && t >= c.t && t <= c.t + c.dur);
    this.background(data.mode, silence);
    ctx.globalCompositeOperation = "screen";
    let visible = 0;
    visible += this.drawDrops(t, data);
    visible += this.drawPoints(t, data);
    if (!silence) visible += this.drawHits(t, data);
    ctx.globalCompositeOperation = "source-over";
    if (this.hatStyle === "bars" && data.hits.some((h) => h.tag === "hat")) this.drawLedBars(t, data, silence);
    if (visible === 0 && !playing && t < 0.05) this.hint(data.mode === "piano" ? "再生すると一音ずつ光ります" : "再生すると打楽器が現れます");
  }

  background(mode, silence) {
    const ctx = this.ctx, w = this.w, h = this.h;
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    if (mode === "piano") {
      bg.addColorStop(0, "#080D11"); bg.addColorStop(0.73, "#0C1619"); bg.addColorStop(1, "#172526");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      const floor = ctx.createLinearGradient(0, h * 0.78, 0, h);
      floor.addColorStop(0, "rgba(56,95,92,.03)"); floor.addColorStop(1, "rgba(80,119,110,.12)");
      ctx.fillStyle = floor; ctx.fillRect(0, h * 0.78, w, h * 0.22);
    } else {
      bg.addColorStop(0, silence ? "#050608" : "#080C13");
      bg.addColorStop(0.72, silence ? "#06080A" : "#101824");
      bg.addColorStop(1, silence ? "#0B0F12" : "#1A202B");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      haze(ctx, w * 0.48, h * 0.98, w * 0.68, h * 0.33, [65, 83, 113], silence ? 0.035 : 0.13);
    }
  }

  hint(text) {
    const ctx = this.ctx;
    ctx.fillStyle = "#AEB8B8"; ctx.font = "13px system-ui, -apple-system, sans-serif"; ctx.textAlign = "center";
    ctx.fillText(text, this.w / 2, this.h / 2); ctx.textAlign = "left";
  }

  // 戻り（drop）: 1100ms の琥珀の空気光
  drawDrops(t, data) {
    const ctx = this.ctx, w = this.w, h = this.h, reduced = this.reduced;
    let n = 0;
    for (let i = lowerBound(data.cues, t - DROP_WINDOW); i < data.cues.length; i++) {
      const cue = data.cues[i]; if (cue.t > t) break;
      if (cue.type !== "drop" || t - cue.t >= DROP_WINDOW) continue;
      n++;
      const age = t - cue.t, progress = age / DROP_WINDOW, life = (1 - progress) * (cue.strength || 1);
      const reach = reduced ? 0.31 : 0.18 + 0.34 * progress;
      haze(ctx, w * 0.5, h * 0.73, w * reach, h * (0.24 + progress * 0.15), [211, 103, 52], 0.26 * life);
      haze(ctx, w * 0.5, h * 0.49, w * reach * 0.75, h * 0.35, [241, 172, 105], 0.13 * life);
      scatteredAir(ctx, w * 0.5, h * 0.61, 16, cue.t * 211, w * reach, h * 0.34, progress, 0.27 * life, [249, 151, 99], reduced);
      for (let layer = 0; layer < 2; layer++) {
        brokenWave(ctx, w * 0.5, h * 0.80, w * reach * (0.77 + layer * 0.34), h * (0.25 + progress * 0.12) * (0.8 + layer * 0.32), cue.t * 100 + layer * 21, 0.12 * life / (1 + layer * 0.4), [247, 170, 107], 1);
      }
      motes(ctx, w * 0.5, h * 0.67, 18, cue.t * 1000, w * reach * 0.9, h * 0.39, progress, 0.35 * life, [255, 191, 130], true, reduced);
    }
    return n;
  }

  // ピアノ単音: 音高→左右位置、推定強度→にじみの大きさと明るさ。中心を塗りつぶさない
  drawPoints(t, data) {
    const ctx = this.ctx, w = this.w, h = this.h, reduced = this.reduced;
    let n = 0;
    for (let index = lowerBound(data.points, t - data.maxDur - POINT_RELEASE); index < data.points.length; index++) {
      const e = data.points[index]; if (e.t > t) break;
      const age = t - e.t;
      if (age > e.dur + POINT_RELEASE) continue;
      const attack = reduced ? 1 : clamp(age / 0.03, 0, 1);
      const release = age <= e.dur ? 1 : clamp(1 - (age - e.dur) / POINT_RELEASE, 0, 1);
      const strength = attack * release * e.level;
      if (strength < 0.008) continue;
      n++;
      const x = w * (0.12 + 0.76 * e.x);
      const y = h * 0.62 - (e.x - 0.5) * h * 0.19;
      const radius = (36 + 50 * e.level) * Math.sqrt(w / 650);
      const seed = e.t * 100 + index * 17;
      const breath = reduced ? 0 : Math.min(1, age / (e.dur + POINT_RELEASE));
      haze(ctx, x, y, radius * 1.55, radius * 1.12, [63, 143, 145], 0.18 * strength);
      haze(ctx, x + (grain(seed) - 0.5) * radius * 0.34, y - radius * (0.34 + breath * 0.12), radius * 0.72, radius * 1.3, [104, 202, 194], 0.15 * strength);
      haze(ctx, x, y, radius * 0.65, radius * 0.73, [183, 249, 236], 0.37 * strength);
      haze(ctx, x, h * 0.82, radius * 1.6, radius * 0.32, [154, 221, 213], 0.11 * strength);
      motes(ctx, x, y, 6, seed, radius * 0.68, radius * 0.82, Math.min(1, breath * 14 / Math.max(1, radius)), 0.25 * strength, [177, 238, 222], false, reduced);
    }
    return n;
  }

  // 打楽器: kick＝中央の白い閃光、snare＝橙の稲妻、hat＝金色の瞬き（位置・半径固定）
  drawHits(t, data) {
    const ctx = this.ctx, w = this.w, h = this.h, reduced = this.reduced;
    const short = Math.min(w, h);
    let n = 0;
    for (let i = lowerBound(data.hits, t - DRUM_WINDOW.hat); i < data.hits.length; i++) {
      const e = data.hits[i]; if (e.t > t) break;
      const age = t - e.t;
      if (age > DRUM_WINDOW[e.tag]) continue;
      n++;
      const level = e.level;
      const seed = e.t * 1000 + ({ kick: 11, snare: 23, hat: 37 }[e.tag] || 0);
      if (e.tag === "kick") {
        const motionScale = reduced ? 0.35 : 1;
        const life = (1 - age / 0.22) ** 2.6 * level * motionScale;
        const impact = (1 - clamp(age / 0.06, 0, 1)) ** 2 * level * motionScale;
        const flash = (1 - clamp(age / 0.08, 0, 1) ** 3) * (0.82 + 0.18 * level) * motionScale;
        haze(ctx, w * 0.5, h * 0.5, short * 0.29, short * 0.29, [87, 143, 231], 0.30 * life);
        haze(ctx, w * 0.5, h * 0.5, short * 0.17, short * 0.17, [164, 208, 255], life);
        haze(ctx, w * 0.5, h * 0.5, short * 0.09, short * 0.09, [246, 252, 255], life);
        if (flash > 0) {
          const radius = short * 0.53;
          const white = ctx.createRadialGradient(w * 0.5, h * 0.5, 0, w * 0.5, h * 0.5, radius);
          white.addColorStop(0, rgba(255, 255, 255, 0.98 * flash));
          white.addColorStop(0.82, rgba(255, 255, 255, 0.90 * flash));
          white.addColorStop(1, rgba(255, 255, 255, 0));
          ctx.fillStyle = white; ctx.fillRect(w * 0.5 - radius, h * 0.5 - radius, radius * 2, radius * 2);
        }
        haze(ctx, w * 0.5, h * 0.5, short * 0.14, short * 0.14, [255, 255, 255], 0.90 * impact);
        haze(ctx, w * 0.5, h * 0.5, short * 0.065, short * 0.065, [255, 255, 255], impact);
      } else if (e.tag === "snare") {
        const progress = age / 0.32, life = (1 - progress) ** 1.5;
        const shift = (e.x - 0.5) * h * 0.08;
        for (const k of [0.25, 0.50, 0.75]) haze(ctx, w * (0.07 + 0.86 * k), h * (0.78 - 0.56 * k) + shift, short * 0.11, short * 0.10, [239, 99, 43], 0.16 * life * level);
        lightning(ctx, w, h, seed, shift, life * level, level);
        motes(ctx, w * 0.5, h * 0.5 + shift, 6, seed, w * 0.34, h * 0.27, progress, 0.48 * life * level, [255, 169, 89], true, reduced);
      } else if (e.tag === "hat") {
        if (this.hatStyle !== "ring") continue; // LEDバー列は drawLedBars で描く
        const life = (1 - age / 0.42) * (0.5 + 0.5 * level);
        const radius = short * 0.14;
        haze(ctx, w * 0.5, h * 0.5, radius * 1.15, radius * 1.15, [239, 170, 64], 0.075 * life);
        goldenRing(ctx, w * 0.5, h * 0.5, radius, seed, life);
      }
    }
    return n;
  }

  // ハイハット: 舞台上辺の LED バー20本。表／裏／3連／16分のスロットごとに担当バーが変わる（数値は TOKEN_SHEET §12）
  drawLedBars(t, data, silence) {
    const ctx = this.ctx, w = this.w, h = this.h;
    const lit = new Float32Array(LED_COUNT);
    if (!silence) {
      for (let i = lowerBound(data.hits, t - DRUM_WINDOW.hat); i < data.hits.length; i++) {
        const e = data.hits[i]; if (e.t > t) break;
        if (e.tag !== "hat") continue;
        const age = t - e.t; if (age > DRUM_WINDOW.hat) continue;
        const life = (1 - age / DRUM_WINDOW.hat) * (0.5 + 0.5 * e.level);
        for (const k of e.leds || []) if (k >= 0 && k < LED_COUNT) lit[k] = Math.max(lit[k], life);
      }
    }
    const x0 = w * 0.08, W = w * 0.84, gap = Math.max(3, w * 0.004);
    const barW = (W - gap * (LED_COUNT - 1)) / LED_COUNT, barH = Math.max(6, h * 0.014), y = h * 0.14 - barH / 2, r = barH / 2;
    const round = (x, yy, ww, hh) => { ctx.beginPath(); ctx.moveTo(x + r, yy); ctx.lineTo(x + ww - r, yy); ctx.arc(x + ww - r, yy + r, r, -Math.PI / 2, Math.PI / 2); ctx.lineTo(x + r, yy + hh); ctx.arc(x + r, yy + r, r, Math.PI / 2, Math.PI * 1.5); ctx.closePath(); };
    ctx.save();
    for (let k = 0; k < LED_COUNT; k++) {
      const x = x0 + k * (barW + gap);
      round(x, y, barW, barH);
      ctx.fillStyle = "rgba(255,232,151,0.05)"; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = "rgba(255,232,151,0.12)"; ctx.stroke();
    }
    ctx.globalCompositeOperation = "screen";
    for (let k = 0; k < LED_COUNT; k++) {
      const life = lit[k]; if (life <= 0.01) continue;
      const x = x0 + k * (barW + gap);
      haze(ctx, x + barW / 2, y + barH / 2, barW * 0.9, barH * 3, [245, 168, 62], 0.35 * life);
      round(x, y, barW, barH);
      ctx.fillStyle = rgba(255, 192, 78, 0.95 * life); ctx.fill();
      round(x + barW * 0.2, y + barH * 0.25, barW * 0.6, barH * 0.5);
      ctx.fillStyle = rgba(255, 240, 200, 0.7 * life); ctx.fill();
    }
    ctx.restore();
  }
}
