// guitar-side.mjs — 左右に振られた音（ギター想定）の打点を、ステレオの左右差から拾う（2026-10-07・TOKEN_SHEET §36）。
// 中央に定位するキック・ベース・歌は左右同じ大きさで入り、左だけ／右だけに振られた楽器は片側だけが大きい。
// 250 Hz〜6 kHz の各周波数で「片側が上回る分（excess）」を取り、その立ち上がり（周波数ごとの増え方の合計）を打点にする。
// 明るさは、その瞬間に片側だけの音が帯域の何割を占めるか（share）で決める＝ギターが大きいほど強い。楽器の判定ではなく定位の判定。
// 純粋関数。音源の再生・外部送信はしない。数値の正本は design/TOKEN_SHEET.md §36。
import { hannWindow, fft } from "./dsp.mjs";

export const SIDE_LAYER = Object.freeze({
  hzLo: 250, hzHi: 6000, fftSize: 2048, hopSec: 0.01,
  medianSec: 1.0,        // 立ち上がりの基準線（ならした中央値）の窓
  peakPercentile: 0.85,  // 基準線を引いた立ち上がりの、この分位点を超えた山だけ
  peakFloor: 0.2,        // かつ、曲の強い立ち上がり（99%点）のこの割合以上（まばらな曲で小さな揺れを拾わない）
  minGapSec: 0.09,       // 同じ側の打点の最小間隔
  minShare: 0.12,        // 片側だけの音が帯域のこれ未満の瞬間は拾わない（左右差のほとんど無い場面）
  shareSmoothSec: 0.25,  // 明るさに使う share のならし
  fullShare: 0.45,       // share がこれ以上で明るさ1（曲の中の相対ではなく絶対。ギターが小さい曲は暗いまま）
  source: "stereo-side-v1",
});

const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function runningMedian(x, radius) {
  const out = new Float32Array(x.length), win = [];
  const insert = (v) => { let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 0, v); };
  const remove = (v) => { let lo = 0, hi = win.length; while (lo < hi) { const m = (lo + hi) >> 1; if (win[m] < v) lo = m + 1; else hi = m; } win.splice(lo, 1); };
  for (let i = 0; i < Math.min(x.length, radius); i++) insert(x[i]);
  for (let i = 0; i < x.length; i++) {
    if (i + radius < x.length) insert(x[i + radius]);
    if (i - radius - 1 >= 0) remove(x[i - radius - 1]);
    out[i] = win[win.length >> 1];
  }
  return out;
}

function percentileOf(values, p) {
  const v = Array.from(values).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))] : 0;
}

/**
 * left/right: Float32Array（同じ長さ）。戻り値 { left:[{t,strength,share}], right:[…], frames, hopSec }。時刻は秒（3桁）。
 * 同じ入力からは同じ結果（乱数なし）。
 */
export function detectSideLayer(left, right, sampleRate, opts = {}) {
  const S = { ...SIDE_LAYER, ...opts };
  const n = Math.min(left?.length || 0, right?.length || 0), N = S.fftSize, hop = Math.max(1, Math.round(S.hopSec * sampleRate));
  if (!(sampleRate > 0) || n < N) return { left: [], right: [], frames: 0, hopSec: hop / (sampleRate || 1) };
  // 中心揃え（analyze-core と同じ・librosa center=True）: フレーム i の窓の中心が i*hop に来るよう、前後を無音として読む。
  const frames = Math.floor(n / hop) + 1, half = N / 2, win = hannWindow(N), hzPerBin = sampleRate / N;
  const k0 = Math.max(1, Math.ceil(S.hzLo / hzPerBin)), k1 = Math.min(N / 2, Math.floor(S.hzHi / hzPerBin)), K = k1 - k0 + 1;
  const gain = 100 * N;   // librosa の振幅スケールに合わせた圧縮（試作 docs/guitar-2026-10-07/side-onsets.py と同じ log1p(100·x)）
  const reL = new Float32Array(N), imL = new Float32Array(N), reR = new Float32Array(N), imR = new Float32Array(N);
  const prev = { left: new Float32Array(K), right: new Float32Array(K) };
  const flux = { left: new Float32Array(frames), right: new Float32Array(frames) }, share = { left: new Float32Array(frames), right: new Float32Array(frames) };
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < N; i++) { const x = off + i - half, inside = x >= 0 && x < n; reL[i] = inside ? left[x] * win[i] : 0; imL[i] = 0; reR[i] = inside ? right[x] * win[i] : 0; imR[i] = 0; }
    fft(reL, imL); fft(reR, imR);
    let exL = 0, exR = 0, tot = 0, fl = 0, fr = 0;
    for (let k = k0, j = 0; k <= k1; k++, j++) {
      const mL = Math.sqrt(reL[k] * reL[k] + imL[k] * imL[k]) / N, mR = Math.sqrt(reR[k] * reR[k] + imR[k] * imR[k]) / N;
      const eL = mL > mR ? mL - mR : 0, eR = mR > mL ? mR - mL : 0;
      exL += eL; exR += eR; tot += (mL + mR) / 2;
      const gL = Math.log1p(gain * eL), gR = Math.log1p(gain * eR);
      if (f > 0) { if (gL > prev.left[j]) fl += gL - prev.left[j]; if (gR > prev.right[j]) fr += gR - prev.right[j]; }
      prev.left[j] = gL; prev.right[j] = gR;
    }
    flux.left[f] = fl; flux.right[f] = fr;
    share.left[f] = tot > 0 ? exL / tot : 0; share.right[f] = tot > 0 ? exR / tot : 0;
  }
  const hopSec = hop / sampleRate, radius = Math.max(1, Math.round(S.medianSec / hopSec / 2)), sr = Math.max(1, Math.round(S.shareSmoothSec / hopSec / 2));
  const out = { frames, hopSec };
  for (const side of ["left", "right"]) {
    const base = runningMedian(flux[side], radius), env = flux[side].map((v, i) => v - base[i]);
    const thr = Math.max(percentileOf(env, S.peakPercentile), S.peakFloor * percentileOf(env, 0.99));
    const sh = share[side], csum = new Float64Array(frames + 1);
    for (let i = 0; i < frames; i++) csum[i + 1] = csum[i] + sh[i];
    const smooth = (i) => { const a = Math.max(0, i - sr), b = Math.min(frames, i + sr + 1); return (csum[b] - csum[a]) / (b - a); };
    const list = [];
    let last = -Infinity;
    for (let i = 2; i < frames - 2; i++) {
      const v = env[i];
      if (!(v > thr) || v < env[i - 1] || v < env[i - 2] || v < env[i + 1] || v < env[i + 2]) continue;
      const s = smooth(i);
      if (sh[i] <= S.minShare || s <= S.minShare || (i - last) * hopSec < S.minGapSec) continue;
      list.push({ t: round3(i * hopSec), strength: round3(clamp01((s - S.minShare) / (S.fullShare - S.minShare))), share: round3(s) });
      last = i;
    }
    out[side] = list;
  }
  return out;
}

/**
 * 解析JSON（Feature Timeline）へ、ギター想定の打点を onset として足す（元の配列に追加・時刻順に並べ直す）。
 * tags:[{name:"guitar"}]、pan −1（左）/ +1（右）、position01 0 / 1。既に同じ印の打点がある JSON には足さない。
 */
export function addSideLayerEvents(ft, layer) {
  if (!ft || !Array.isArray(ft.events) || ft.events.some((e) => e.tags?.some((x) => x.name === "guitar"))) return 0;
  const bandIds = (ft.bands || []).map((b) => b.id), band = bandIds.includes("mid") ? "mid" : bandIds[0];
  let added = 0;
  for (const side of ["left", "right"]) for (const p of layer[side] || []) {
    const confidence = round3(Math.min(0.95, 0.35 + 0.6 * p.strength));
    ft.events.push({ t: p.t, type: "onset", strength: p.strength, band, bands: Object.fromEntries(bandIds.map((id) => [id, id === band ? 1 : 0])),
      confidence, tags: [{ name: "guitar", confidence, source: SIDE_LAYER.source }], pan: side === "left" ? -1 : 1, position01: side === "left" ? 0 : 1, sideShare: p.share });
    added++;
  }
  ft.events.sort((a, b) => a.t - b.t);
  return added;
}
