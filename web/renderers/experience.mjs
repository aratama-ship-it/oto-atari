// experience.mjs — 打点・単音・ベース・無音/戻り・拍を、舞台（stage3d.mjs）が使う形にまとめる純粋関数群（時刻決定型）。
// 2026-10-07: 「体験」表示（ExperienceRenderer：閃光・稲妻・粒子・上辺のLEDバー）は本人指定で外した（design/TOKEN_SHEET.md §32）。
// 描画コードは v0.7.2（commit 44d20c9）の同名ファイルにある。ファイル名と collectExperienceData の名前は既存の参照を保つため据え置く。

// 打点として舞台へ渡す印。guitar は左右に振られた音（guitar-side.mjs・TOKEN_SHEET §36）で、x（0＝左・1＝右）で側を決める。
const DRUM_TAGS = ["kick", "snare", "hat", "guitar"];
const DRUM_WINDOW = { kick: 0.22, snare: 0.32, hat: 0.42, guitar: 0.35 };
const SAME_HIT_SEC = 0.01;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

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
 * 離散 Intent と Feature Timeline の events から、舞台表示が使う形へまとめる（純粋関数・テスト対象）。
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
      if (d.srcInstrument === "bass") continue;
      const dur = Math.max(0, d.dur || 0);
      maxDur = Math.max(maxDur, dur);
      points.push({ t: d.t, dur, x: clamp(typeof d.x === "number" ? d.x : 0.5, 0, 1), level: clamp(d.level ?? 0.4, 0, 1), pitch: d.srcPitchMidi });
    } else if (DRUM_TAGS.includes(d.srcTag)) {
      const key = d.srcTag === "guitar" ? `guitar:${typeof d.x === "number" && d.x < 0.5 ? "L" : "R"}` : d.srcTag;   // ギターは左右別々に数える
      const last = lastByTag[key];
      if (last !== undefined && d.t - last <= SAME_HIT_SEC) continue;
      lastByTag[key] = d.t;
      hits.push({ t: d.t, tag: d.srcTag, level: d.srcTag === "guitar" ? clamp(d.srcStrength ?? 0, 0, 1) : clamp(d.srcStrength ?? d.size ?? 0.5, 0.2, 1), x: typeof d.x === "number" ? d.x : 0.5 });
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
  // 曲全体の音程を残す。ルールをOFFにしても舞台の台数・担当位置は動かさない。
  const pointSources = events.filter((e) => (e.type === "note" && e.instrumentCandidate !== "bass") ||
    (e.type === "onset" && Number.isFinite(e.position01) && e.tags?.some((tag) => tag.name === "pitched-attack")))
    .map((e) => ({ pitch: e.type === "note" ? e.pitchMidi : undefined, x: e.position01 }));
  // beats は舞台のミラーボールのピンが「キック・スネアの無い曲」で拍へ回るために保持する（時刻と拍内位置だけ）。
  const beatList = usable ? beats.map((b) => ({ t: b.t, beatInBar: b.beatInBar })) : [];
  // ベース（2026-10-05）: 台数・担当位置は曲全体の bass note から決め（規則をOFFにしても動かさない）、
  // 点灯は規則（bass-floor-wash など）を通った意図だけから作る。
  const bassSources = events.filter((e) => e.type === "note" && e.instrumentCandidate === "bass").map((e) => ({ pitch: e.pitchMidi }));
  const bassNotes = sorted.filter((d) => d.intent === "point" && d.srcInstrument === "bass")
    .map((d) => ({ t: d.t, soundDur: d.srcSoundDur ?? d.dur, pitch: d.srcPitchMidi, level: clamp(d.level ?? 0, 0, 1), envelope: d.srcEnvelope }));
  return { hits, points, pointSources, bassSources, bassNotes, cues, maxDur, mode: points.length ? "piano" : "drums", ledBars: cls.bars, ledFallback: !usable, beats: beatList };
}

// 舞台表示が打楽器の減衰窓を参照する。
export { DRUM_WINDOW };
