// analyze-core.mjs — モノラル PCM から Feature Timeline v1 を作る（JS版・ブラウザ/Node 共用）。
// 仕様: ../../schema/FEATURE_TIMELINE_SPEC.md。Python 版（analysis/analyze.py）と同じ形式を出す。
import { detectDrums, mergeDrumsIntoEvents, refineGridWithDrums } from "./drums.mjs?v=20261008a";   // 2026-10-08: キック判定を変えたので版を付ける（§44）
import { stftMagnitudes, binRange, normalizeDb, clamp01, movingAverage, pickPeaks, estimateTempo, fitBeatGrid, noveltyCurve, percentile } from "./dsp.mjs";

export const ANALYZER_VERSION = "0.1.0";
export const DEFAULT_BANDS = [
  { id: "sub", hz: [20, 60] }, { id: "bass", hz: [60, 160] }, { id: "lowmid", hz: [160, 500] },
  { id: "mid", hz: [500, 2000] }, { id: "high", hz: [2000, 6000] }, { id: "air", hz: [6000, 16000] },
];

const r3 = (v) => Math.round(v * 1000) / 1000;
const arr3 = (a) => Array.from(a, r3);

export function analyzePCM(mono, sampleRate, { hopSec = 0.01, fftSize = 2048, fileName = "", channels = 1, bands = DEFAULT_BANDS, onProgress, stereo = null, sensitivity = 3, reinforce = true } = {}) {
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const durationSec = mono.length / sampleRate;
  // 中心揃え STFT: 先頭に fftSize/2 の無音を足し、フレーム i の中心が i*hop に来るようにする（librosa center=True と同じ規約）。
  const padded = new Float32Array(mono.length + fftSize);
  padded.set(mono, fftSize / 2);
  const stft = stftMagnitudes(padded, sampleRate, { fftSize, hop });
  const { mags, frames, bins, hzPerBin } = stft;
  onProgress?.(0.4, "spectrum");

  // ---- 帯域エネルギー・重心・平坦度・フラックス（フレーム毎）
  const ranges = bands.map((b) => binRange(b.hz[0], Math.min(b.hz[1], sampleRate / 2), hzPerBin, bins));
  const bandE = bands.map(() => new Float32Array(frames));
  const bandFlux = bands.map(() => new Float32Array(frames));
  const total = new Float32Array(frames), centroid = new Float32Array(frames), flatness = new Float32Array(frames), flux = new Float32Array(frames);
  const [gLo, gHi] = binRange(20, Math.min(16000, sampleRate / 2), hzPerBin, bins);
  const logLo = Math.log(20), logHi = Math.log(16000);
  let prev = null;
  for (let f = 0; f < frames; f++) {
    const m = mags[f];
    let sumE = 0, sumFM = 0, sumM = 0, sumLog = 0, cnt = 0;
    for (let k = gLo; k <= gHi; k++) {
      const v = m[k], e = v * v;
      sumE += e; sumM += v; sumFM += v * (k * hzPerBin); sumLog += Math.log(v + 1e-12); cnt++;
    }
    total[f] = sumE;
    const c = sumM > 1e-12 ? sumFM / sumM : 20;
    centroid[f] = clamp01((Math.log(Math.max(20, c)) - logLo) / (logHi - logLo));
    flatness[f] = sumM > 1e-12 ? clamp01(Math.exp(sumLog / cnt) / (sumM / cnt)) : 0;
    let fl = 0;
    for (let b = 0; b < bands.length; b++) {
      const [lo, hi] = ranges[b];
      let e = 0, bf = 0;
      for (let k = lo; k <= hi; k++) { e += m[k] * m[k]; if (prev) { const d = m[k] - prev[k]; if (d > 0) bf += d; } }
      bandE[b][f] = e; bandFlux[b][f] = bf; fl += bf;
    }
    flux[f] = fl;
    prev = m;
  }
  onProgress?.(0.6, "features");

  const loudness = normalizeDb(total);
  const bandCurves = bandE.map((e) => normalizeDb(e, { rangeDb: 45 }));
  const fluxNorm = (() => { const p = percentile(flux, 99) || 1; return Float32Array.from(flux, (v) => clamp01(v / p)); })();
  const meanE = bandE.map((e) => e.reduce((a, b) => a + b, 0) / frames);
  const maxMean = Math.max(1e-12, ...meanE);
  const bandGain = Object.fromEntries(bands.map((b, i) => [b.id, r3(meanE[i] / maxMean)]));

  // ---- onset: 帯域別フラックスのピークを 30ms 以内で統合
  const mergeFrames = Math.max(1, Math.round(0.03 / hopSec));
  const minDist = Math.max(1, Math.round(0.05 / hopSec));
  const perBandPeaks = bandFlux.map((bf) => {
    const p99 = percentile(bf, 99) || 1;
    const norm = Float32Array.from(bf, (v) => v / p99);
    return { peaks: pickPeaks(movingAverage(norm, 1), { radius: Math.round(0.25 / hopSec), ratio: 1.6, delta: 0.06, minDistance: minDist }), norm };
  });
  const candidates = [];
  perBandPeaks.forEach(({ peaks, norm }, b) => peaks.forEach((i) => candidates.push({ i, b, v: norm[i] })));
  candidates.sort((a, b) => a.i - b.i);
  const onsets = [];
  for (const c of candidates) {
    const last = onsets[onsets.length - 1];
    if (last && c.i - last.i <= mergeFrames) { last.contrib[c.b] = Math.max(last.contrib[c.b], c.v); if (c.v > last.peakV) { last.peakV = c.v; } continue; }
    const contrib = new Array(bands.length).fill(0); contrib[c.b] = c.v;
    onsets.push({ i: c.i, contrib, peakV: c.v });
  }
  const fluxAtOnsets = onsets.map((o) => flux[o.i]);
  const fluxRef = percentile(fluxAtOnsets, 95) || 1;
  const events = [];
  for (const o of onsets) {
    const strength = clamp01(flux[o.i] / fluxRef);
    if (strength < 0.08) continue;
    const sumC = o.contrib.reduce((a, b) => a + b, 0) || 1;
    const rel = o.contrib.map((v) => v / sumC);
    let bi = 0; for (let b = 1; b < bands.length; b++) if (rel[b] > rel[bi]) bi = b;
    const bandsObj = Object.fromEntries(bands.map((b, k) => [b.id, r3(rel[k])]));
    const t = r3(o.i * hopSec);
    const tags = tagOnset(rel, bands, flatness[o.i], strength, bandCurves, o.i, hopSec);
    const ev = { t, type: "onset", strength: r3(strength), band: bands[bi].id, bands: bandsObj, confidence: 0.6 };
    if (tags.length) ev.tags = tags;
    events.push(ev);
    const active = rel.filter((v) => v >= 0.15).length;
    if (strength >= 0.8 && active >= 3) events.push({ t, type: "accent", strength: r3(strength), bands: bandsObj, confidence: 0.6 });
  }
  onProgress?.(0.75, "onsets");

  // ---- tempo（一定格子）
  const env = movingAverage(fluxNorm, 1);
  const tempo = estimateTempo(env, hopSec);
  const beatTimes = fitBeatGrid(env, hopSec, tempo.bpm, durationSec);
  const lowEnv = movingAverage(perBandPeaks[0].norm.map((v, i) => v + perBandPeaks[1].norm[i]), 1);
  let barPhase = 0, bestBar = -Infinity, scores = [];
  for (let p = 0; p < 4; p++) {
    let s = 0;
    for (let k = p; k < beatTimes.length; k += 4) { const i = Math.round(beatTimes[k] / hopSec); s += (lowEnv[i] || 0) + 0.5 * (env[i] || 0); }
    scores.push(s); if (s > bestBar) { bestBar = s; barPhase = p; }
  }
  const sorted = [...scores].sort((a, b) => b - a);
  const barConfidence = sorted[0] > 0 ? clamp01((sorted[0] - sorted[1]) / sorted[0]) : 0;
  const beats = beatTimes.map((t, index) => {
    const i = Math.round(t / hopSec);
    const beatInBar = ((index - barPhase) % 4 + 4) % 4;
    return { t: r3(t), index, bar: Math.floor((index - barPhase + 4) / 4) - 1 + (barPhase === 0 ? 1 : 1) - 1, beatInBar, strength: r3(clamp01(env[i] || 0)) };
  });
  // bar 番号を 0 始まりに整える
  const firstDown = beats.findIndex((b) => b.beatInBar === 0);
  beats.forEach((b, k) => { b.bar = Math.floor((k - firstDown + 4) / 4) - 1; });
  const downbeats = beats.filter((b) => b.beatInBar === 0).map((b) => b.t);

  // ---- sections: 0.5秒ごとの特徴ベクトルでノベルティ
  const step = Math.max(1, Math.round(0.5 / hopSec));
  const feats = [];
  for (let f = 0; f + step <= frames; f += step) {
    const v = [];
    for (let b = 0; b < bands.length; b++) { let s = 0; for (let k = f; k < f + step; k++) s += bandCurves[b][k]; v.push(s / step); }
    let sc = 0, sf = 0, sl = 0; for (let k = f; k < f + step; k++) { sc += centroid[k]; sf += flatness[k]; sl += loudness[k]; }
    v.push(sc / step, sf / step, sl / step * 1.5);
    feats.push(v);
  }
  const kernelHalf = Math.max(2, Math.round(4 / 0.5));
  const nov = noveltyCurve(feats, kernelHalf);
  const bounds = pickPeaks(nov, { radius: 6, ratio: 1.2, delta: 0.15, minDistance: Math.round(6 / 0.5) }).map((i) => i * step * hopSec);
  const sectionsRaw = [];
  let start = 0;
  for (const b of bounds) { if (b - start >= 4) { sectionsRaw.push([start, b]); start = b; } }
  sectionsRaw.push([start, durationSec]);
  const sections = labelSections(sectionsRaw, { loudness, centroid, bandCurves, bands, hopSec, nov, step });
  for (const s of sections.slice(1)) events.push({ t: s.start, type: "sectionChange", strength: r3(s.novelty), sectionId: s.id, label: s.label, confidence: s.confidence });
  onProgress?.(0.9, "sections");

  // ---- drop / build / silence
  events.push(...detectDrops(loudness, hopSec));
  events.push(...detectBuilds(centroid, fluxNorm, hopSec));
  events.push(...detectSilences(loudness, hopSec));
  events.sort((a, b) => a.t - b.t || a.type.localeCompare(b.type));

  const curves = { loudness: arr3(loudness), centroid: arr3(centroid), flux: arr3(fluxNorm), flatness: arr3(flatness) };
  bands.forEach((b, i) => { curves[`band.${b.id}`] = arr3(bandCurves[i]); });
  curves.bandGain = bandGain;
  onProgress?.(0.95, "drums");
  const result = {
    format: "oto-atari.feature-timeline", version: 1,
    source: { file: fileName, durationSec: r3(durationSec), sampleRate, channels, analyzedAt: new Date().toISOString(),
      analyzer: { name: "oto-atari-js", version: ANALYZER_VERSION, params: { hopSec, fftSize } }, stems: null },
    clock: { hopSec, frames },
    bands,
    tempo: { bpm: r3(tempo.bpm), confidence: r3(tempo.confidence), beatsPerBar: 4, barConfidence: r3(barConfidence), grid: "fixed", beats, downbeats },
    sections, curves, events,
  };
  applyDrums(result, stft, hopSec, { sampleRate, sensitivity, stereo, reinforce });
  onProgress?.(1, "done");
  return result;
}

/**
 * 打楽器判定を二段構えで行う。
 *  1段目: 拍格子の事前情報なしで確度の高いキック等を検出（通常閾値）。
 *  2段目: 1段目の検出結果で拍格子を補正し（refineGridWithDrums）、補正済みの格子を使って
 *         「毎拍キック（四つ打ち等）」の規則性から拾い漏れをゆるい閾値で復元し直す。
 * 曲の規則性を先に確定してから拾い漏れを補う、という考え方（2026-09-28 本人指示）。
 */
function applyDrums(ft, stft, hopSec, { sampleRate, sensitivity, stereo: stereoRaw, reinforce = true }) {
  const stereo = stereoRaw ? { ...stereoRaw, sampleRate } : null;
  const pass1 = detectDrums(stft, hopSec, { sampleRate, sensitivity, stereo });
  const scratch = { tempo: JSON.parse(JSON.stringify(ft.tempo)), source: { durationSec: ft.source.durationSec } };
  const refined = refineGridWithDrums(scratch, pass1);
  const pass2 = detectDrums(stft, hopSec, { sampleRate, sensitivity, stereo, beats: scratch.tempo.beats.map((b) => b.t), reinforce });
  // 2026-10-07 夜: 焼き込んだクラップ（分離した音や書き出したトラック由来・TOKEN_SHEET §40）がある曲では、ミックスからのスネア推定を使わない。
  // 見本曲ではスネア推定74件のうち2・4拍目のクラップに当たるのは31件で、43件は誤検出だった。SS はクラップの印だけで点ける。
  const bakedClap = Boolean(ft.source?.bakedTags?.clap) || ft.events.some((e) => e.tags?.some((x) => x.name === "clap"));
  if (bakedClap) pass2.snares = [];
  mergeDrumsIntoEvents(ft, pass2);
  if (refined.applied) ft.tempo = scratch.tempo;
  ft.drums.grid = refined;
  if (bakedClap) ft.drums.snareSuppressedByBakedClap = true;
  return ft;
}

/** 既存の Feature Timeline（Python版など）に、PCM から自前の打楽器判定を足す。同じ PCM で JS版が出す結果と同じ tags/格子補正になる。 */
export function refineWithDrums(ft, mono, sampleRate, { fftSize = 2048, stereo = null, sensitivity = 3, reinforce = true } = {}) {
  const hopSec = ft.clock.hopSec;
  const hop = Math.max(1, Math.round(hopSec * sampleRate));
  const padded = new Float32Array(mono.length + fftSize);
  padded.set(mono, fftSize / 2);
  const stft = stftMagnitudes(padded, sampleRate, { fftSize, hop });
  return applyDrums(ft, stft, hopSec, { sampleRate, sensitivity, stereo, reinforce });
}

function tagOnset(rel, bands, flat, strength, bandCurves, i, hopSec) {
  const g = (id) => rel[bands.findIndex((b) => b.id === id)] || 0;
  const tags = [];
  const low = g("sub") + g("bass"), hi = g("high") + g("air"), mid = g("mid"), lowmid = g("lowmid");
  const decayFrames = Math.round(0.15 / hopSec);
  const bassIdx = bands.findIndex((b) => b.id === "bass");
  const bassDecay = bandCurves[bassIdx][i] - (bandCurves[bassIdx][Math.min(bandCurves[bassIdx].length - 1, i + decayFrames)] || 0);
  if (low >= 0.55) tags.push({ name: "kick", confidence: r3(clamp01(0.35 + 0.4 * low + (bassDecay > 0.05 ? 0.15 : 0))) });
  if (lowmid >= 0.2 && hi >= 0.2 && flat >= 0.35) tags.push({ name: "snare", confidence: r3(clamp01(0.3 + 0.5 * Math.min(lowmid, hi) + 0.2 * flat)) });
  if (hi >= 0.7 && strength < 0.5) tags.push({ name: "hat", confidence: r3(clamp01(0.3 + 0.5 * hi)) });
  if (mid >= 0.45 && flat < 0.3) tags.push({ name: "stab", confidence: r3(clamp01(0.3 + 0.5 * mid)) });
  if (flat >= 0.6) tags.push({ name: "noise", confidence: r3(clamp01(flat)) });
  return tags;
}

function labelSections(raw, { loudness, centroid, bandCurves, bands, hopSec, nov, step }) {
  const mean = (arr, a, b) => { const i0 = Math.round(a / hopSec), i1 = Math.max(i0 + 1, Math.round(b / hopSec)); let s = 0, n = 0; for (let i = i0; i < i1 && i < arr.length; i++) { s += arr[i]; n++; } return n ? s / n : 0; };
  const out = raw.map(([start, end], k) => {
    const energy = mean(loudness, start, end), brightness = mean(centroid, start, end);
    const bandMeans = bands.map((b, i) => mean(bandCurves[i], start, end));
    let bi = 0; for (let i = 1; i < bandMeans.length; i++) if (bandMeans[i] > bandMeans[bi]) bi = i;
    const ni = Math.round(start / hopSec / step);
    return { id: `S${k + 1}`, start: r3(start), end: r3(end), label: "A", energy: r3(energy), brightness: r3(brightness), dominantBand: bands[bi].id, novelty: r3(k === 0 ? 1 : (nov[ni] || 0)), confidence: 0.4 };
  });
  const energies = out.map((s) => s.energy);
  const eMax = Math.max(1e-6, ...energies);
  let ab = 0;
  out.forEach((s, k) => {
    const rel = s.energy / eMax;
    const prevRel = k > 0 ? out[k - 1].energy / eMax : rel;
    if (k === 0 && out.length > 1) s.label = "intro";
    else if (k === out.length - 1 && out.length > 2 && rel < 0.7) s.label = "outro";
    else if (rel < 0.45) s.label = "break";
    else if (rel - prevRel >= 0.25) s.label = "drop";
    else if (k > 0 && s.brightness - out[k - 1].brightness >= 0.08 && rel >= prevRel) s.label = "build";
    else { s.label = ab % 2 === 0 ? "A" : "B"; ab++; }
  });
  return out;
}

function detectDrops(loudness, hopSec) {
  const out = [];
  const pre = Math.round(2 / hopSec), post = Math.round(0.5 / hopSec), gap = Math.round(2 / hopSec);
  let lastI = -Infinity;
  for (let i = pre; i + post < loudness.length; i++) {
    if (i - lastI < gap) continue;
    let a = 0; for (let k = i - pre; k < i; k++) a += loudness[k]; a /= pre;
    let b = 0; for (let k = i; k < i + post; k++) b += loudness[k]; b /= post;
    if (a < 0.45 && b > 0.65 && b - a >= 0.3) { out.push({ t: r3(i * hopSec), type: "drop", strength: r3(clamp01((b - a) / 0.6)), fromEnergy: r3(a), toEnergy: r3(b), confidence: 0.6 }); lastI = i; }
  }
  return out;
}

function detectBuilds(centroid, flux, hopSec) {
  const out = [];
  const win = Math.round(0.5 / hopSec);
  const c = movingAverage(centroid, win), f = movingAverage(flux, win);
  let runStart = -1;
  for (let i = win; i < c.length; i += win) {
    const up = c[i] > c[i - win] - 0.005 && f[i] > f[i - win] - 0.01 && (c[i] > c[i - win] || f[i] > f[i - win]);
    if (up) { if (runStart < 0) runStart = i - win; }
    else {
      if (runStart >= 0 && (i - win - runStart) * hopSec >= 2) {
        const rise = (c[i - win] - c[runStart]) + (f[i - win] - f[runStart]);
        if (rise > 0.15) out.push({ t: r3(runStart * hopSec), type: "build", strength: r3(clamp01(rise)), dur: r3((i - win - runStart) * hopSec), endT: r3((i - win) * hopSec), confidence: 0.4 });
      }
      runStart = -1;
    }
  }
  return out;
}

function detectSilences(loudness, hopSec) {
  const out = [];
  const minLen = Math.round(0.4 / hopSec);
  let s = -1;
  for (let i = 0; i <= loudness.length; i++) {
    const quiet = i < loudness.length && loudness[i] < 0.03;
    if (quiet && s < 0) s = i;
    if (!quiet && s >= 0) { if (i - s >= minLen) out.push({ t: r3(s * hopSec), type: "silence", strength: 1, dur: r3((i - s) * hopSec), confidence: 0.7 }); s = -1; }
  }
  return out;
}

/** ステレオ等の複数チャンネルをモノラルへ。 */
export function downmix(channelsData) {
  if (channelsData.length === 1) return channelsData[0];
  const n = channelsData[0].length, out = new Float32Array(n);
  for (const ch of channelsData) for (let i = 0; i < n; i++) out[i] += ch[i] / channelsData.length;
  return out;
}
