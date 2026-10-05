// validate.mjs — Feature Timeline / Mapping の軽量検証（外部ライブラリなし）。エラー文字列の配列を返す（空＝合格）。
const BANDS = ["sub", "bass", "lowmid", "mid", "high", "air"];
const EVENT_TYPES = new Set(["onset", "accent", "drop", "build", "silence", "sectionChange"]);
const INTENTS = new Set(["splat", "pulse", "wash", "strobe", "sweep", "blackout", "palette", "haze"]);
const in01 = (v) => typeof v === "number" && v >= 0 && v <= 1;
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export function validateFeatureTimeline(ft) {
  const e = [];
  if (!ft || typeof ft !== "object") return ["object ではない"];
  if (ft.format !== "oto-atari.feature-timeline") e.push("format が違う");
  if (![1, 2].includes(ft.version)) e.push("version は 1 または 2 が必要");
  if (!ft.source || typeof ft.source.durationSec !== "number") e.push("source.durationSec がない");
  if (!ft.clock || !(ft.clock.hopSec > 0) || !(ft.clock.frames > 0)) e.push("clock が不正");
  if (!Array.isArray(ft.bands) || !ft.bands.every((b) => b.id && Array.isArray(b.hz) && b.hz.length === 2)) e.push("bands が不正");
  const bandIds = new Set((ft.bands || []).map((b) => b.id));
  if (!ft.tempo || typeof ft.tempo.bpm !== "number" || !Array.isArray(ft.tempo.beats)) e.push("tempo が不正");
  else {
    if (!in01(ft.tempo.confidence)) e.push("tempo.confidence が 0〜1 でない");
    if (!ft.tempo.beats.every((b, i, a) => typeof b.t === "number" && (i === 0 || a[i - 1].t <= b.t))) e.push("tempo.beats が昇順でない");
    if (!Array.isArray(ft.tempo.downbeats)) e.push("tempo.downbeats がない");
  }
  if (!Array.isArray(ft.sections) || !ft.sections.length) e.push("sections が空");
  else for (const s of ft.sections) if (!(s.id && typeof s.start === "number" && typeof s.end === "number" && s.end > s.start)) { e.push("section が不正: " + JSON.stringify(s).slice(0, 80)); break; }
  if (!ft.curves) e.push("curves がない");
  else {
    const frames = ft.clock && ft.clock.frames;
    for (const k of ["loudness", "centroid", "flux", ...BANDS.filter((b) => bandIds.has(b)).map((b) => `band.${b}`)]) {
      const c = ft.curves[k];
      if (!Array.isArray(c)) { e.push(`curves.${k} がない`); continue; }
      if (c.length !== frames) e.push(`curves.${k} の長さ ${c.length} ≠ frames ${frames}`);
      if (!c.every(in01)) e.push(`curves.${k} に 0〜1 外の値`);
    }
    if (!ft.curves.bandGain || typeof ft.curves.bandGain !== "object") e.push("curves.bandGain がない");
  }
  if (!Array.isArray(ft.events)) e.push("events がない");
  else {
    let prev = -Infinity;
    for (const ev of ft.events) {
      if (typeof ev.t !== "number" || ev.t < prev - 1e-9) { e.push("events が昇順でない/ t 不正"); break; }
      prev = ev.t;
      if (!EVENT_TYPES.has(ev.type) && !(ft.version === 2 && ev.type === "note")) { e.push("未知の event.type: " + ev.type); break; }
      if (!in01(ev.strength)) { e.push("event.strength が 0〜1 でない: " + JSON.stringify(ev).slice(0, 80)); break; }
      if (ev.type === "note" && (!finite(ev.t) || !(ev.dur > 0) || !Number.isInteger(ev.pitchMidi) || ev.pitchMidi < 21 || ev.pitchMidi > 108 || typeof ev.pitchName !== "string" || !finite(ev.pitchHz) || ev.pitchHz <= 0 || !in01(ev.position01) || Math.abs(ev.position01 - (ev.pitchMidi - 21) / 87) > 0.002 || !in01(ev.modelStrength01) || Math.abs(ev.strength - ev.modelStrength01) > 0.002 || ev.status !== "unverified_model_candidate" || !["piano", "bass"].includes(ev.instrumentCandidate) || ev.t + ev.dur > (ft.source?.durationSec ?? 0) + 0.05)) { e.push("note 候補の音高・強度・時刻・由来が不正"); break; }
      if (ev.type === "note") {
        if (ev.confidence !== undefined && (!in01(ev.confidence) || typeof ev.confidenceKind !== "string")) { e.push("note.confidence は 0〜1、confidenceKind は文字列が必要"); break; }
        if (ev.soundDur !== undefined && (!finite(ev.soundDur) || ev.soundDur <= 0 || ev.soundDur < ev.dur - 0.001 - 1e-9 || ev.t + ev.soundDur > (ft.source?.durationSec ?? 0) + 0.05 + 1e-9)) { e.push("note.soundDur の長さ・終端が不正"); break; }
        if (ev.release !== undefined) {
          const r = ev.release;
          if (!r || typeof r !== "object" || !["measured", "unconfirmed"].includes(r.status) || !finite(ev.soundDur)) { e.push("note.release は measured または unconfirmed と soundDur が必要"); break; }
          if (r.status === "measured" && (!finite(r.soundEndSec) || Math.abs(r.soundEndSec - (ev.t + ev.soundDur)) > 0.002 + 1e-9)) { e.push("note.release.soundEndSec が t + soundDur と一致しない"); break; }
          if (r.status === "unconfirmed" && Math.abs(ev.soundDur - ev.dur) > 0.001 + 1e-9) { e.push("note.release が unconfirmed の soundDur は dur と一致が必要"); break; }
          if (r.status === "measured" || r.envelope !== undefined) {
            const env = r.envelope;
            if (!Array.isArray(env) || env.length < 1 || env.length > 16 || !env.every((p, i) => Array.isArray(p) && p.length === 2 && finite(p[0]) && p[0] >= 0 && in01(p[1]) && (i === 0 ? p[0] === 0 && p[1] === 1 : p[0] > env[i - 1][0]))) { e.push("note.release.envelope は先頭 [0, 1]・時刻昇順・相対値 0〜1 の最大16点が必要"); break; }
          }
        }
      }
      if (ev.type === "onset" && !bandIds.has(ev.band)) { e.push("onset.band が bands にない: " + ev.band); break; }
      if (ev.tags && !ev.tags.every((t) => t && typeof t.name === "string" && in01(t.confidence))) { e.push("tags は {name, confidence} の配列"); break; }
    }
    // ピアノの和音・重なりは許容し、bass の次音侵入だけを検査する。
    const bass = ft.events.filter((ev) => ev.type === "note" && ev.instrumentCandidate === "bass");
    for (let i = 0; i < bass.length - 1; i++) {
      if (bass[i].t + (bass[i].soundDur ?? bass[i].dur) > bass[i + 1].t + 0.01 + 1e-9) { e.push("bass note の終端が次の bass note に 0.01 秒を超えて侵入している"); break; }
    }
  }
  return e;
}

export function validateMapping(m) {
  const e = [];
  if (!m || typeof m !== "object") return ["object ではない"];
  if (m.format !== "oto-atari.mapping") e.push("format が違う");
  if (![1, 2].includes(m.version)) e.push("version は 1 または 2 が必要");
  if (!m.palettes || typeof m.palettes !== "object" || !Object.keys(m.palettes).length) e.push("palettes が空");
  if (m.startPalette && !(m.palettes && m.palettes[m.startPalette])) e.push("startPalette が palettes にない");
  if (!Array.isArray(m.rules)) e.push("rules がない");
  else m.rules.forEach((r, i) => {
    if (!r || !r.id) e.push(`rules[${i}] に id がない`);
    if (!r.on || (!r.on.event && !r.on.curve)) e.push(`rules[${i}].on に event か curve が必要`);
    if (!r.emit || (!INTENTS.has(r.emit.intent) && !(m.version === 2 && r.emit.intent === "point"))) e.push(`rules[${i}].emit.intent が不正: ${r.emit && r.emit.intent}`);
    if (r.emit?.intent === "point" && !(r.on?.event && r.emit.x !== undefined && r.emit.level !== undefined && r.emit.dur !== undefined)) e.push(`rules[${i}]: point は on.event と x/level/dur が必要`);
    if (r.emit?.level && typeof r.emit.level === "object" && r.emit.level.secondaryFrom !== undefined &&
      (typeof r.emit.level.from !== "string" || typeof r.emit.level.secondaryFrom !== "string" || !in01(r.emit.level.secondaryWeight))) e.push(`rules[${i}]: level の secondaryFrom には from と0〜1の secondaryWeight が必要`);
    if (r.emit && (r.emit.intent === "wash" || r.emit.intent === "haze") && !(r.on && r.on.curve)) e.push(`rules[${i}]: ${r.emit.intent} は on.curve が必要`);
    if (r.emit && r.emit.intent === "palette" && !(r.emit.name || (r.emit.cycle && r.emit.cycle.length))) e.push(`rules[${i}]: palette は name か cycle が必要`);
    if (r.quantize && !["none", "beat", "half", "bar"].includes(r.quantize.to)) e.push(`rules[${i}].quantize.to が不正`);
  });
  return e;
}
