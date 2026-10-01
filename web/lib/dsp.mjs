// dsp.mjs — 依存なしの信号処理部品。ブラウザと Node の両方で動く（Float32Array のみ）。
// ドメイン語彙（楽器名など）は持ち込まない。

export function hannWindow(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  return w;
}

/** 実数入力の radix-2 FFT。re/im は長さ n（2の冪）。in-place。 */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

/** 振幅スペクトル列を返す。frames × (fftSize/2+1)。 */
export function stftMagnitudes(mono, sampleRate, { fftSize = 2048, hop = 480 } = {}) {
  const win = hannWindow(fftSize);
  const bins = fftSize / 2 + 1;
  const frames = Math.max(1, Math.floor((mono.length - fftSize) / hop) + 1);
  const out = new Array(frames);
  const re = new Float32Array(fftSize), im = new Float32Array(fftSize);
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < fftSize; i++) { re[i] = (mono[off + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    const mag = new Float32Array(bins);
    for (let k = 0; k < bins; k++) mag[k] = Math.hypot(re[k], im[k]) / fftSize;
    out[f] = mag;
  }
  return { mags: out, frames, bins, hzPerBin: sampleRate / fftSize };
}

export function binRange(hzLo, hzHi, hzPerBin, bins) {
  const lo = Math.max(1, Math.floor(hzLo / hzPerBin));
  const hi = Math.min(bins - 1, Math.ceil(hzHi / hzPerBin));
  return [lo, Math.max(lo + 1, hi)];
}

export function percentile(arr, p) {
  const a = Array.from(arr).filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[idx];
}

/** dB 化して「ピーク−rangeDb 〜 ピーク」を 0〜1 へ。ピークは 99.5 パーセンタイル。 */
export function normalizeDb(energies, { rangeDb = 50, eps = 1e-12 } = {}) {
  const db = Float32Array.from(energies, (e) => 10 * Math.log10(e + eps));
  const peak = percentile(db, 99.5);
  const floor = peak - rangeDb;
  const out = new Float32Array(db.length);
  for (let i = 0; i < db.length; i++) out[i] = clamp01((db[i] - floor) / (peak - floor));
  return out;
}

export function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

export function movingAverage(arr, radius) {
  const n = arr.length, out = new Float32Array(n);
  let sum = 0, count = 0;
  const q = [];
  for (let i = 0; i < n + radius; i++) {
    if (i < n) { sum += arr[i]; count++; q.push(arr[i]); }
    if (q.length > 2 * radius + 1) { sum -= q.shift(); count--; }
    const center = i - radius;
    if (center >= 0 && center < n) out[center] = sum / count;
  }
  return out;
}

/** 適応閾値つきピーク検出。ratio 倍の局所平均＋delta を超える局所最大。 */
export function pickPeaks(x, { radius = 8, ratio = 1.5, delta = 0.02, minDistance = 5 } = {}) {
  const avg = movingAverage(x, radius);
  const peaks = [];
  let last = -Infinity;
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] <= x[i - 1] || x[i] < x[i + 1]) continue;
    if (x[i] < avg[i] * ratio + delta) continue;
    if (i - last < minDistance) { if (x[i] > x[peaks[peaks.length - 1]]) { peaks[peaks.length - 1] = i; last = i; } continue; }
    peaks.push(i); last = i;
  }
  return peaks;
}

/** 自己相関によるテンポ推定。env は onset 包絡（frame 単位）。返り値 { bpm, confidence, lagFrames }。 */
export function estimateTempo(env, hopSec, { minBpm = 60, maxBpm = 200, preferBpm = 120 } = {}) {
  const n = env.length;
  const mean = env.reduce((a, b) => a + b, 0) / Math.max(1, n);
  const x = Float32Array.from(env, (v) => v - mean);
  const minLag = Math.max(1, Math.floor(60 / (maxBpm * hopSec)));
  const maxLag = Math.min(n - 2, Math.ceil(60 / (minBpm * hopSec)));
  if (maxLag <= minLag) return { bpm: preferBpm, confidence: 0, lagFrames: Math.round(60 / (preferBpm * hopSec)) };
  const acf = new Float32Array(maxLag + 1);
  let norm = 0;
  for (let i = 0; i < n; i++) norm += x[i] * x[i];
  norm = norm || 1;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    acf[lag] = s / norm;
  }
  // 好みのテンポ付近をゆるく優先（Rayleigh 型の重み）。倍テンポ・半テンポの取り違えを減らす。
  const sigma = 60 / (preferBpm * hopSec);
  let best = minLag, bestScore = -Infinity, sum = 0, count = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const w = (lag / (sigma * sigma)) * Math.exp(-(lag * lag) / (2 * sigma * sigma));
    const score = acf[lag] * (0.6 + 0.4 * w / (1 / (sigma * Math.exp(0.5))));
    sum += Math.max(0, acf[lag]); count++;
    if (score > bestScore) { bestScore = score; best = lag; }
  }
  // 放物線補間でラグを細かく
  let lagRefined = best;
  if (best > minLag && best < maxLag) {
    const a = acf[best - 1], b = acf[best], c = acf[best + 1];
    const denom = a - 2 * b + c;
    if (Math.abs(denom) > 1e-9) lagRefined = best + 0.5 * (a - c) / denom;
  }
  const meanAcf = sum / Math.max(1, count);
  const confidence = clamp01((acf[best] - meanAcf) / Math.max(1e-6, 1 - meanAcf));
  return { bpm: 60 / (lagRefined * hopSec), confidence, lagFrames: lagRefined };
}

/** 一定 BPM の格子の位相を、包絡の総和が最大になるよう選ぶ。返り値は拍時刻（秒）の配列。 */
export function fitBeatGrid(env, hopSec, bpm, durationSec) {
  const period = 60 / bpm;
  const periodFrames = period / hopSec;
  let bestPhase = 0, bestScore = -Infinity;
  const steps = Math.max(8, Math.round(periodFrames));
  for (let s = 0; s < steps; s++) {
    const phase = (s / steps) * periodFrames;
    let score = 0;
    for (let f = phase; f < env.length; f += periodFrames) {
      const i = Math.round(f);
      score += (env[i] || 0) + 0.5 * ((env[i - 1] || 0) + (env[i + 1] || 0));
    }
    if (score > bestScore) { bestScore = score; bestPhase = phase; }
  }
  const beats = [];
  for (let t = bestPhase * hopSec; t < durationSec; t += period) beats.push(t);
  return beats;
}

/** 特徴ベクトル列の自己類似からノベルティ（境界らしさ）を計算。kernelHalf は片側フレーム数。 */
export function noveltyCurve(features, kernelHalf) {
  const n = features.length;
  const out = new Float32Array(n);
  const dist = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - b[k]; s += d * d; } return Math.sqrt(s); };
  for (let i = kernelHalf; i < n - kernelHalf; i++) {
    let within = 0, across = 0, cw = 0, ca = 0;
    for (let a = i - kernelHalf; a < i; a += 1) {
      for (let b = i; b < i + kernelHalf; b += 1) { across += dist(features[a], features[b]); ca++; }
    }
    for (let a = i - kernelHalf; a < i; a += 2) for (let b = a + 1; b < i; b += 2) { within += dist(features[a], features[b]); cw++; }
    for (let a = i; a < i + kernelHalf; a += 2) for (let b = a + 1; b < i + kernelHalf; b += 2) { within += dist(features[a], features[b]); cw++; }
    out[i] = Math.max(0, across / Math.max(1, ca) - within / Math.max(1, cw));
  }
  const mx = Math.max(1e-9, ...out);
  for (let i = 0; i < n; i++) out[i] /= mx;
  return out;
}
