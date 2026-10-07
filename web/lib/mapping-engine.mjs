// mapping-engine.mjs — Feature Timeline × Mapping → Intent Timeline（事前計算）。
// 仕様: ../../schema/MAPPING_SPEC.md。出力先（インク・照明・γ）はここで作る Intent だけを読む。

export const INTENT_FORMAT = "oto-atari.intent-timeline";
const DISCRETE = new Set(["splat", "pulse", "strobe", "sweep", "blackout", "palette", "point"]);
const CONTINUOUS = new Set(["wash", "haze"]);

export function compileIntents(ft, mapping, { limits } = {}) {
  assertFormat(ft, "oto-atari.feature-timeline", [1, 2]);
  assertFormat(mapping, "oto-atari.mapping", [1, 2]);
  const hopSec = ft.clock.hopSec, frames = ft.clock.frames;
  const maxPerSec = (limits && limits.maxPerSec) || (mapping.limits && mapping.limits.maxPerSec) || 24;
  const events = withVirtualEvents(ft);
  const sectionAt = makeSectionLookup(ft.sections || []);
  const rules = (mapping.rules || []).filter((r) => r && r.enabled !== false);

  // 1) palette の時間変化を先に決める（他の規則の @palette.* 解決に必要）
  const paletteTimeline = [{ t: -Infinity, name: mapping.startPalette || Object.keys(mapping.palettes || {})[0] || "default" }];
  for (const rule of rules) {
    if (!rule.emit || rule.emit.intent !== "palette" || !rule.on || !rule.on.event) continue;
    let cycleIdx = 0;
    for (const ev of matchEvents(events, rule.on, sectionAt)) {
      let name = rule.emit.name;
      if (rule.emit.cycle && rule.emit.cycle.length) { name = rule.emit.cycle[cycleIdx % rule.emit.cycle.length]; cycleIdx++; }
      if (name && mapping.palettes && mapping.palettes[name]) paletteTimeline.push({ t: ev.t, name, ruleId: rule.id });
    }
  }
  paletteTimeline.sort((a, b) => a.t - b.t);
  const paletteAt = (t) => { let cur = paletteTimeline[0]; for (const p of paletteTimeline) { if (p.t <= t) cur = p; else break; } return cur.name; };
  const palettes = mapping.palettes || {};

  // 2) 離散 Intent
  const discrete = [];
  const beatGrid = (ft.tempo && ft.tempo.beats || []).map((b) => b.t);
  for (const rule of rules) {
    const emit = rule.emit;
    if (!emit || !DISCRETE.has(emit.intent) || emit.intent === "palette" || !rule.on || !rule.on.event) continue;
    for (const ev of matchEvents(events, rule.on, sectionAt)) {
      const t = quantizeTime(ev.t, rule.quantize, beatGrid, ft.tempo);
      const pal = palettes[paletteAt(t)] || {};
      const intent = { t: round3(t), intent: emit.intent, ruleId: rule.id, srcType: ev.type, srcStrength: ev.strength };
      if (ev.type === "note") {
        intent.srcInstrument = ev.instrumentCandidate;
        if (ev.soundDur !== undefined) intent.srcSoundDur = ev.soundDur;
        if (ev.release?.envelope !== undefined) intent.srcEnvelope = ev.release.envelope;
        intent.srcPitchMidi = ev.pitchMidi;
        intent.srcPitchName = ev.pitchName;
        intent.srcModelStrength = ev.modelStrength01;
        if (Number.isFinite(ev.mixLevel01)) intent.srcMixLevel = ev.mixLevel01;
        intent.srcStatus = ev.status;
      }
      if (rule.on.tags && ev.tags) {
        const names = new Set([].concat(rule.on.tags));
        const hit = ev.tags.find((x) => names.has(typeof x === "string" ? x : x.name));
        if (hit && typeof hit === "object") { intent.srcTag = hit.name; intent.srcConfidence = hit.confidence; if (hit.patternConfirmed) intent.srcPattern = true; }
      }
      for (const [key, spec] of Object.entries(emit)) {
        if (key === "intent") continue;
        intent[key] = resolveParam(spec, ev, pal, ft, null);
      }
      if (intent.zone === undefined) intent.zone = "all";
      discrete.push(intent);
    }
  }
  discrete.sort((a, b) => a.t - b.t);
  // 規則が自分の上限（limit.maxPerSec）を持つ時は、その規則の中だけで間引き、全体の上限には数えない（2026-10-07・ギター）。
  const ownLimit = new Map(rules.filter((r) => r.limit && r.limit.maxPerSec > 0).map((r) => [r.id, r.limit.maxPerSec]));
  const shared = discrete.filter((d) => !ownLimit.has(d.ruleId));
  const thinned = [...thinPerSecond(shared, maxPerSec), ...[...ownLimit].flatMap(([id, cap]) => thinPerSecond(discrete.filter((d) => d.ruleId === id), cap))]
    .sort((a, b) => a.t - b.t);

  // 3) 連続 Intent（曲線を事前にスムージングした配列にする）
  const continuous = [];
  for (const rule of rules) {
    const emit = rule.emit;
    if (!emit || !CONTINUOUS.has(emit.intent) || !rule.on || !rule.on.curve) continue;
    const src = ft.curves[rule.on.curve];
    if (!Array.isArray(src)) continue;
    const levelSpec = emit.level !== undefined ? emit.level : { from: rule.on.curve };
    const values = new Float32Array(frames);
    const gate = rule.on.section && rule.on.section.label ? new Set([].concat(rule.on.section.label)) : null;
    for (let i = 0; i < frames; i++) {
      const t = i * hopSec;
      if (gate) { const s = sectionAt(t); if (!s || !gate.has(s.label)) { values[i] = 0; continue; } }
      values[i] = clamp01(resolveParam(levelSpec, { value: src[i], curves: ft.curves, i }, palettes[paletteAt(t)] || {}, ft, i));
    }
    const smooth = (typeof levelSpec === "object" && levelSpec && levelSpec.smooth) || emit.smooth;
    if (smooth) applyAttackRelease(values, hopSec, smooth.attackSec || 0, smooth.releaseSec || 0);
    const colorSpec = emit.color;
    const colorPerFrame = colorSpec && typeof colorSpec === "object" && colorSpec.gradient
      ? Array.from({ length: frames }, (_, i) => resolveParam(colorSpec, { value: src[i], curves: ft.curves, i }, palettes[paletteAt(i * hopSec)] || {}, ft, i))
      : null;
    const staticColor = colorPerFrame ? null : resolveParam(colorSpec, { value: 0, curves: ft.curves, i: 0 }, palettes[paletteAt(0)] || {}, ft, 0);
    continuous.push({ intent: emit.intent, ruleId: rule.id, zone: emit.zone || "all", curve: rule.on.curve, values: Array.from(values, round3), color: staticColor, colorPerFrame,
      paletteKey: typeof colorSpec === "string" && colorSpec.startsWith("@palette.") ? colorSpec.slice(9) : null });
  }

  return {
    format: INTENT_FORMAT, version: mapping.version === 2 ? 2 : 1,
    source: { file: ft.source && ft.source.file, durationSec: ft.source && ft.source.durationSec, mapping: mapping.name },
    clock: { hopSec, frames },
    palettes, paletteTimeline: paletteTimeline.map((p) => ({ ...p, t: Number.isFinite(p.t) ? round3(p.t) : 0 })),
    discrete: thinned, continuous,
    stats: { discreteBefore: discrete.length, discreteAfter: thinned.length, rules: rules.length },
  };
}

/** 再生時の問い合わせ: [t0, t1) の離散 Intent。二分探索。 */
export function discreteBetween(it, t0, t1) {
  const arr = it.discrete;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t0) lo = mid + 1; else hi = mid; }
  const out = [];
  for (let i = lo; i < arr.length && arr[i].t < t1; i++) out.push(arr[i]);
  return out;
}

/** 再生時の問い合わせ: 時刻 t の連続 Intent の値。 */
export function continuousAt(it, t) {
  const i = Math.max(0, Math.min(it.clock.frames - 1, Math.floor(t / it.clock.hopSec)));
  return it.continuous.map((c) => ({ intent: c.intent, zone: c.zone, ruleId: c.ruleId, level: c.values[i] || 0,
    color: c.colorPerFrame ? c.colorPerFrame[i] : (c.paletteKey ? (paletteColorAt(it, t, c.paletteKey) || c.color) : c.color) }));
}

export function paletteNameAt(it, t) { let cur = it.paletteTimeline[0]; for (const p of it.paletteTimeline) { if (p.t <= t) cur = p; else break; } return cur ? cur.name : null; }
export function paletteColorAt(it, t, key) { const name = paletteNameAt(it, t); return name && it.palettes[name] ? it.palettes[name][key] : undefined; }

// ---------- 内部 ----------

function assertFormat(doc, format, versions) {
  if (!doc || doc.format !== format) throw new Error(`形式が違います: ${format} を期待、${doc && doc.format} を受け取りました`);
  if (!versions.includes(doc.version)) throw new Error(`${format} の版が違います: v${versions.join("/v")} を期待、v${doc.version}`);
}

function withVirtualEvents(ft) {
  const out = (ft.events || []).slice();
  for (const b of (ft.tempo && ft.tempo.beats) || []) {
    out.push({ t: b.t, type: "beat", strength: b.strength ?? 0.5, beatInBar: b.beatInBar, bar: b.bar, confidence: ft.tempo.confidence ?? 0.5 });
    if (b.beatInBar === 0) out.push({ t: b.t, type: "downbeat", strength: b.strength ?? 0.5, beatInBar: 0, bar: b.bar, confidence: ft.tempo.barConfidence ?? 0 });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function makeSectionLookup(sections) {
  return (t) => { for (const s of sections) if (t >= s.start && t < s.end) return s; return sections[sections.length - 1] || null; };
}

function matchEvents(events, on, sectionAt) {
  const types = new Set([].concat(on.event));
  const bands = on.band ? new Set([].concat(on.band)) : null;
  const tags = on.tags ? [].concat(on.tags) : null;
  const beatInBar = on.beatInBar ? new Set([].concat(on.beatInBar)) : null;
  const labels = on.section && on.section.label ? new Set([].concat(on.section.label)) : null;
  const instruments = on.instrument ? new Set([].concat(on.instrument)) : null;
  const stems = on.stem ? new Set([].concat(on.stem)) : null;
  return events.filter((ev) => {
    if (!types.has(ev.type)) return false;
    if (on.minStrength !== undefined && (ev.strength ?? 0) < on.minStrength) return false;
    if (on.maxStrength !== undefined && (ev.strength ?? 0) > on.maxStrength) return false;
    if (on.minConfidence !== undefined && (ev.confidence ?? 0) < on.minConfidence) return false;
    if (bands && !bands.has(ev.band)) return false;
    if (beatInBar && !beatInBar.has(ev.beatInBar)) return false;
    if (instruments && !instruments.has(ev.instrumentCandidate)) return false;
    if (stems && !stems.has(ev.stem)) return false;
    if (tags) {
      const names = new Set((ev.tags || []).map((x) => (typeof x === "string" ? x : x.name)));
      const ok = on.tagsMode === "all" ? tags.every((x) => names.has(x)) : tags.some((x) => names.has(x));
      if (!ok) return false;
    }
    if (labels) { const s = sectionAt(ev.t); if (!s || !labels.has(s.label)) return false; }
    return true;
  });
}

function quantizeTime(t, q, beatGrid, tempo) {
  if (!q || !q.to || q.to === "none" || !beatGrid.length) return t;
  let grid = beatGrid;
  if (q.to === "half") { grid = []; for (let i = 0; i < beatGrid.length - 1; i++) grid.push(beatGrid[i], (beatGrid[i] + beatGrid[i + 1]) / 2); grid.push(beatGrid[beatGrid.length - 1]); }
  if (q.to === "bar") grid = (tempo.downbeats && tempo.downbeats.length) ? tempo.downbeats : beatGrid;
  let lo = 0, hi = grid.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (grid[mid] < t) lo = mid + 1; else hi = mid; }
  const a = grid[Math.max(0, lo - 1)], b = grid[lo];
  const nearest = Math.abs(a - t) <= Math.abs(b - t) ? a : b;
  const maxShift = q.maxShiftSec ?? 0.12;
  return Math.abs(nearest - t) <= maxShift ? nearest : t;
}

function resolveParam(spec, ev, pal, ft, frameIndex) {
  if (spec === null || spec === undefined) return spec;
  if (typeof spec === "number" || typeof spec === "boolean") return spec;
  if (typeof spec === "string") {
    if (spec.startsWith("@palette.")) return pal[spec.slice(9)] ?? "#ffffff";
    return spec;
  }
  if (Array.isArray(spec)) return spec;
  if (typeof spec === "object") {
    if (spec.from === undefined && !spec.gradient) return spec; // 任意のオブジェクトはそのまま
    let v = readSource(spec.from, ev, ft, frameIndex);
    // Optional second event value. Missing loudness falls back to the primary value.
    if (spec.secondaryFrom && Number.isFinite(ev[spec.secondaryFrom])) {
      const weight = clamp01(spec.secondaryWeight ?? 0.5);
      v = (1 - weight) * v + weight * readSource(spec.secondaryFrom, ev, ft, frameIndex);
    }
    if (spec.gradient) return gradientColor(spec.gradient, clamp01(v));
    const [inLo, inHi] = spec.domain || [0, 1];
    let x = inHi === inLo ? 0 : clamp01((v - inLo) / (inHi - inLo));
    x = shape(x, spec.curve);
    const [lo, hi] = spec.range || [0, 1];
    return lo + (hi - lo) * x;
  }
  return spec;
}

function readSource(from, ev, ft, frameIndex) {
  if (from === undefined || from === "value") return ev.value ?? ev.strength ?? 0;
  if (from === "strength") return ev.strength ?? 0;
  if (from.startsWith("bands.")) return (ev.bands && ev.bands[from.slice(6)]) ?? 0;
  if (from in ev) return Number(ev[from]) || 0;
  // curve 名（連続 Intent、または離散 Intent が発火時刻の曲線値を読む）
  const curve = ft.curves && ft.curves[from];
  if (Array.isArray(curve)) {
    const i = frameIndex ?? Math.max(0, Math.min(curve.length - 1, Math.round((ev.t || 0) / ft.clock.hopSec)));
    return curve[i] ?? 0;
  }
  return 0;
}

function shape(x, curve) {
  if (!curve || curve === "linear") return x;
  if (curve === "pow2") return x * x;
  if (curve === "pow1.5") return Math.pow(x, 1.5);
  if (curve === "pow0.5") return Math.sqrt(x);
  if (curve === "step") return x >= 0.5 ? 1 : 0;
  if (curve.startsWith("pow")) { const p = parseFloat(curve.slice(3)); return Number.isFinite(p) ? Math.pow(x, p) : x; }
  return x;
}

function applyAttackRelease(values, hopSec, attackSec, releaseSec) {
  const aA = attackSec > 0 ? Math.exp(-hopSec / attackSec) : 0;
  const aR = releaseSec > 0 ? Math.exp(-hopSec / releaseSec) : 0;
  let y = 0;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    const a = x > y ? aA : aR;
    y = a * y + (1 - a) * x;
    values[i] = y;
  }
}

function thinPerSecond(list, maxPerSec) {
  if (!maxPerSec || list.length === 0) return list;
  const buckets = new Map();
  for (const it of list) { const k = Math.floor(it.t); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(it); }
  const out = [];
  for (const [, arr] of buckets) {
    if (arr.length <= maxPerSec) { out.push(...arr); continue; }
    const keep = arr.slice().sort((a, b) => (b.srcStrength ?? 0) - (a.srcStrength ?? 0)).slice(0, maxPerSec);
    const set = new Set(keep);
    out.push(...arr.filter((x) => set.has(x)));
  }
  return out.sort((a, b) => a.t - b.t);
}

export function gradientColor(stops, x) {
  if (!stops || !stops.length) return "#ffffff";
  if (stops.length === 1) return stops[0];
  const pos = x * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(pos)), f = pos - i;
  const a = hexToRgb(stops[i]), b = hexToRgb(stops[i + 1]);
  return rgbToHex(a.map((v, k) => Math.round(v + (b[k] - v) * f)));
}
export function hexToRgb(hex) { const h = String(hex).replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
export function rgbToHex([r, g, b]) { return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, "0")).join(""); }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function round3(v) { return Math.round(v * 1000) / 1000; }
