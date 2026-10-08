// low-pitch.mjs — 前面LED用の低音程。30〜200Hzだけを2kHz/512点FFTで読む。
import { fft, percentile } from "./dsp.mjs";

/** 55Hz を 0 とする半音。十分な低域がないフレームは -99。 */
export function lowPitchCurve(mono, sampleRate, hopSec, frames) {
  const out = Array(Math.max(0, frames)).fill(-99);
  if (!mono || !sampleRate || !(hopSec > 0) || !frames) return out;
  const rate = 2000, step = sampleRate / rate, n = 512, half = n >> 1;
  const energy = new Float64Array(frames), spectra = new Array(frames);
  const re = new Float32Array(n), im = new Float32Array(n);
  for (let f = 0; f < frames; f++) {
    // 2kHzより上を先に移動平均で落としてから間引く（alias を低域へ入れない）。
    const center = Math.round(f * hopSec * sampleRate), start = center - Math.round(n * step / 2);
    for (let i = 0; i < n; i++) {
      const p = start + i * step; let sum = 0;
      for (let j = -3; j <= 3; j++) sum += mono[Math.round(p + j * step)] || 0;
      re[i] = (sum / 7) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))); im[i] = 0;
    }
    fft(re, im);
    const mags = new Float32Array(half + 1); let e = 0;
    for (let k = Math.ceil(30 * n / rate); k <= Math.floor(200 * n / rate); k++) { const m = re[k] * re[k] + im[k] * im[k]; mags[k] = m; e += m; }
    energy[f] = e; spectra[f] = mags;
  }
  const floor = percentile(energy, 20);
  for (let f = 0; f < frames; f++) {
    if (!(energy[f] > floor + 1e-12)) continue;
    const mags = spectra[f]; let kBest = Math.ceil(30 * n / rate);
    for (let k = kBest + 1; k <= Math.floor(200 * n / rate); k++) if (mags[k] > mags[kBest]) kBest = k;
    // 対数スペクトルの放物線補間で、512点のbin幅より細かく読む。
    const a = Math.log(mags[kBest - 1] + 1e-20), b = Math.log(mags[kBest] + 1e-20), c = Math.log(mags[kBest + 1] + 1e-20);
    const d = Math.abs(a - 2 * b + c) > 1e-12 ? 0.5 * (a - c) / (a - 2 * b + c) : 0;
    const hz = (kBest + Math.max(-0.5, Math.min(0.5, d))) * rate / n;
    out[f] = 12 * Math.log2(hz / 55);
  }
  return out;
}
