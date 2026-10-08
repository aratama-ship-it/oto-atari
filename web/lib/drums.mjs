// drums.mjs — 混ざった音源から「拍を担う打楽器」（kick / snare / hat）の位置を自前で判定する。
// 方針: 楽器の音色を取り出すのではなく、各打楽器に固有の「帯域 × 立ち上がりの速さ × 減衰の短さ」だけを見る。
//   kick : 40〜120Hz の急な立ち上がり（30ms で +6dB 以上）と短い減衰（200ms で −6dB 以上）。持続するベース音は減衰しないので除外。
//   snare: 150〜400Hz（胴）と 2〜8kHz（響き線）の両方が同時に立ち上がり、雑音的。
//   hat  : 7〜16kHz の立ち上がりで、2kHz 以下がほぼ動かない。
// 入力は stftMagnitudes の出力（中心揃え）。返り値は { kicks, snares, hats } 各 [{ t, strength, confidence, detail }]。
import { binRange, movingAverage, percentile, fft as fftInPlace } from "./dsp.mjs";

const dB = (e) => 10 * Math.log10(e + 1e-12);

/** 高めに鳴るキックの帯域（TOKEN_SHEET §44・2026-10-08）。上帯域の候補にだけ掛ける3条件は感度で動かさない。 */
export const KICK_UPPER = { hz: [100, 180], lowRiseDb: 2, lowDecayDb: 1, wireDensityRelDb: -20 };

function bandEnergy(mags, lo, hi) {
  const out = new Float32Array(mags.length);
  for (let f = 0; f < mags.length; f++) { const m = mags[f]; let e = 0; for (let k = lo; k <= hi; k++) e += m[k] * m[k]; out[f] = e; }
  return out;
}

/** 立ち上がり候補: logE の上昇（riseFrames 前との差）が閾値を超える局所最大。 */
function risePeaks(logE, { riseFrames, minRiseDb, minGapFrames, radius }) {
  const n = logE.length, rise = new Float32Array(n);
  for (let i = riseFrames; i < n; i++) rise[i] = Math.max(0, logE[i] - Math.min(logE[i - riseFrames], logE[i - Math.max(1, riseFrames >> 1)]));
  const avg = movingAverage(rise, radius);
  const peaks = [];
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    if (rise[i] < rise[i - 1] || rise[i] < rise[i + 1]) continue;
    if (rise[i] < minRiseDb || rise[i] < avg[i] * 1.3 + 1) continue;
    if (i - last < minGapFrames) { if (rise[i] > rise[peaks[peaks.length - 1]]) { peaks[peaks.length - 1] = i; last = i; } continue; }
    peaks.push(i); last = i;
  }
  return { peaks, rise };
}

/** 感度 1〜5（既定 3）。大きいほど閾値が下がり拾いやすくなる（拾いすぎも増える）。 */
export function thresholdsFor(sensitivity = 3) {
  const k = Math.max(1, Math.min(5, Number(sensitivity) || 3));
  const f = 1 - (k - 3) * 0.25;           // 1→1.5倍厳しい … 5→0.5倍ゆるい
  return { kickRise: 6 * f, kickDecay: 6 * f, kickFloor: 12 * f, snareBodyRise: 5 * f, snareWireRise: 4 * f, snareDecay: 4 * f, hatRise: 4 * f, hatFloor: 8 * f, hatLowRise: 4 / f };
}

export function detectDrums(stft, hopSec, { sampleRate, sensitivity = 3, stereo = null, beats = null, reinforce = true } = {}) {
  const TH = thresholdsFor(sensitivity);
  const { mags, bins, hzPerBin } = stft;
  const fr = (sec) => Math.max(1, Math.round(sec / hopSec));
  const [kLo, kHi] = binRange(40, 120, hzPerBin, bins);
  const [bodyLo, bodyHi] = binRange(150, 400, hzPerBin, bins);
  const [wireLo, wireHi] = binRange(2000, 8000, hzPerBin, bins);
  const [hatLo, hatHi] = binRange(7000, Math.min(16000, sampleRate ? sampleRate / 2 - 1 : 16000), hzPerBin, bins);
  const [lowLo, lowHi] = binRange(40, 2000, hzPerBin, bins);
  const eKick = bandEnergy(mags, kLo, kHi), eBody = bandEnergy(mags, bodyLo, bodyHi), eWire = bandEnergy(mags, wireLo, wireHi), eHat = bandEnergy(mags, hatLo, hatHi), eLow = bandEnergy(mags, lowLo, lowHi);
  const lKick = Float32Array.from(eKick, dB), lBody = Float32Array.from(eBody, dB), lWire = Float32Array.from(eWire, dB), lHat = Float32Array.from(eHat, dB), lLow = Float32Array.from(eLow, dB);
  const floorKick = percentile(lKick, 20), floorHat = percentile(lHat, 20), floorWire = percentile(lWire, 20);

  // ---- kick
  // 2026-10-08（TOKEN_SHEET §44）: 40〜120Hz に加えて、高めに鳴るキックの胴（100〜180Hz）も見る。サブベースが 40〜120Hz を埋める曲や
  // キックの胴が 120Hz より上にある曲（dddd の2曲ではキックの 34〜37%）では、低域だけでは立ち上がり・減衰が閾値に届かなかった
  // （docs/research-2026-10-08-kick-bass/）。閾値を下げても戻らない＝帯域の問題。
  // 上の帯域の候補は、スネアの胴・クラップ・ベースの頭を拾わないよう3条件を付ける（合成テストと実曲で確認）:
  //   低域も少し上がって（2dB）200ms で少し下がる（1dB）／ 2〜8kHz の帯域あたり密度が胴より 20dB 以上低い。
  const kicks = [];
  {
    const [uLo, uHi] = binRange(KICK_UPPER.hz[0], KICK_UPPER.hz[1], hzPerBin, bins);
    const lUpper = Float32Array.from(bandEnergy(mags, uLo, uHi), dB);
    const densUpper = 10 * Math.log10(uHi - uLo + 1), densWire = 10 * Math.log10(wireHi - wireLo + 1);
    const cands = []; let riseLow = null;
    for (const [band, lK, upper] of [["low", lKick, false], ["upper", lUpper, true]]) {
      const floor = upper ? percentile(lK, 20) : floorKick;
      const { peaks, rise } = risePeaks(lK, { riseFrames: fr(0.03), minRiseDb: TH.kickRise, minGapFrames: fr(0.09), radius: fr(0.3) });
      if (!upper) riseLow = rise;
      const riseRef = percentile(peaks.map((i) => rise[i]), 90) || 1;
      for (const i of peaks) {
        // ピーク（+60ms 以内の最大）と減衰（ピークから +200ms で −6dB 以上）
        let pk = i, pkV = lK[i];
        for (let j = i; j <= Math.min(lK.length - 1, i + fr(0.06)); j++) if (lK[j] > pkV) { pkV = lK[j]; pk = j; }
        if (pkV - floor < TH.kickFloor) continue;                           // 床に近い＝無視
        const after = lK[Math.min(lK.length - 1, pk + fr(0.2))];
        const decayDb = pkV - after;
        if (decayDb < TH.kickDecay) continue;                               // 減衰しない＝持続音（ベース）
        if (upper) {
          let lr = 0; for (let j = Math.max(0, i - 2); j <= Math.min(riseLow.length - 1, i + 2); j++) lr = Math.max(lr, riseLow[j]);
          if (lr < KICK_UPPER.lowRiseDb) continue;                          // 低域が動かない＝スネアの胴だけ
          let p2 = i, v2 = lKick[i]; for (let j = Math.max(0, i - 2); j <= Math.min(lKick.length - 1, i + 6); j++) if (lKick[j] > v2) { v2 = lKick[j]; p2 = j; }
          if (v2 - lKick[Math.min(lKick.length - 1, p2 + fr(0.2))] < KICK_UPPER.lowDecayDb) continue;   // 低域が下がらない＝ベースの頭
          let vw = -Infinity; for (let j = Math.max(0, pk - 2); j <= Math.min(lWire.length - 1, pk + 2); j++) vw = Math.max(vw, lWire[j]);
          if (vw - densWire >= pkV - densUpper + KICK_UPPER.wireDensityRelDb) continue;   // 高域の密度が胴に迫る＝クラップ・スネア
        }
        const strength = Math.min(1, rise[i] / riseRef);
        const confidence = Math.min(0.95, 0.4 + 0.3 * Math.min(1, (decayDb - TH.kickDecay) / 12) + 0.25 * strength);
        cands.push({ t: round3(i * hopSec), strength: round3(strength), confidence: round3(confidence), pan: panAt(stereo, i * hopSec, upper ? KICK_UPPER.hz[0] : 40, upper ? KICK_UPPER.hz[1] : 120), detail: { band, riseDb: round1(rise[i]), decayDb: round1(decayDb), peakDb: round1(pkV - floor) } });
      }
    }
    // 2帯域の候補を 50ms で統合（同じ打点なら強い方を残す）
    cands.sort((a, b) => a.t - b.t || b.strength - a.strength);
    // lowEvidence: 低域（40〜120Hz）でも見つかった打点か。スネア／ハットの「キックと重なる」関門はこれだけを見る＝スネア・ハットの結果は改修前と同じ
    // 統合の優先: 低域で見つかった打点はそのまま残す（時刻・強さ・確度とも改修前と同一）。上帯域は低域が見つけなかった打点だけ足す
    for (const c of cands) {
      const last = kicks[kicks.length - 1];
      if (last && c.t - last.t <= 0.05) {
        if (last.detail.band === "low") { last.detail.lowEvidence = true; continue; }
        if (c.detail.band === "low") { c.detail.lowEvidence = true; kicks[kicks.length - 1] = c; continue; }
        if (c.strength > last.strength) kicks[kicks.length - 1] = c;
        kicks[kicks.length - 1].detail.lowEvidence = false; continue;
      }
      c.detail.lowEvidence = c.detail.band === "low"; kicks.push(c);
    }
  }
  const lowKicks = kicks.filter((k) => k.detail.lowEvidence);   // 改修前のキック集合（スネア／ハットの関門用）
  // ---- kick の規則性で拾い漏れを補完（例: 四つ打ち＝毎拍キック）。
  // 「弱く鳴っている拍」を毎回ゆるい閾値で検出すると誤検出が増えるため、まず通常の閾値で確度の高いキックを
  // 十分な数取ってから、その並び自体が周期的かどうかを見て、周期が強い曲だけ・その位置だけをゆるく調べ直す。
  // ---- snare
  const snares = [];
  {
    const { peaks: pb, rise: rb } = risePeaks(lBody, { riseFrames: fr(0.03), minRiseDb: TH.snareBodyRise, minGapFrames: fr(0.08), radius: fr(0.3) });
    const { rise: rw } = risePeaks(lWire, { riseFrames: fr(0.03), minRiseDb: TH.snareWireRise, minGapFrames: fr(0.08), radius: fr(0.3) });
    const win = fr(0.02);
    const ref = percentile(pb.map((i) => rb[i]), 90) || 1;
    for (const i of pb) {
      let wireRise = 0; for (let j = Math.max(0, i - win); j <= Math.min(rw.length - 1, i + win); j++) wireRise = Math.max(wireRise, rw[j]);
      if (wireRise < TH.snareWireRise) continue;                            // 響き線側が立ち上がらない＝スネアでない
      if (lWire[i] - floorWire < 8) continue;
      if (lowKicks.some((k) => Math.abs(k.t - i * hopSec) <= 0.03) && lWire[i] < lBody[i] - 10) continue;  // キックのアタック音（キックと重なるときは響き線が胴に匹敵する場合だけスネア）。上帯域だけのキックは見ない（§44）
      const after = lBody[Math.min(lBody.length - 1, i + fr(0.25))];
      if (lBody[i] - after < TH.snareDecay) continue;                       // 減衰しない
      const strength = Math.min(1, rb[i] / ref);
      snares.push({ t: round3(i * hopSec), strength: round3(strength), confidence: round3(Math.min(0.9, 0.35 + 0.3 * Math.min(1, wireRise / 10) + 0.25 * strength)), pan: panAt(stereo, i * hopSec, 150, 8000), detail: { bodyRiseDb: round1(rb[i]), wireRiseDb: round1(wireRise) } });
    }
  }
  // ---- hat
  const hats = [];
  {
    const { peaks, rise } = risePeaks(lHat, { riseFrames: fr(0.02), minRiseDb: TH.hatRise, minGapFrames: fr(0.06), radius: fr(0.25) });
    const ref = percentile(peaks.map((i) => rise[i]), 90) || 1;
    for (const i of peaks) {
      if (lHat[i] - floorHat < TH.hatFloor) continue;
      const lowRise = Math.max(0, lLow[i] - lLow[Math.max(0, i - fr(0.02))]);
      if (lowRise > TH.hatLowRise) continue;                                            // 低域も一緒に立ち上がる＝キック/スネアの付帯音
      const tSec = i * hopSec;
      if (lowKicks.some((k) => Math.abs(k.t - tSec) <= 0.03) || snares.some((k) => Math.abs(k.t - tSec) <= 0.03)) continue;
      const strength = Math.min(1, rise[i] / ref);
      hats.push({ t: round3(i * hopSec), strength: round3(strength), confidence: round3(Math.min(0.85, 0.35 + 0.25 * strength + 0.25 * Math.min(1, (4 - lowRise) / 4))), pan: panAt(stereo, i * hopSec, 7000, 16000), detail: { riseDb: round1(rise[i]), lowRiseDb: round1(lowRise) } });
    }
  }
  // ---- kick の規則性で拾い漏れを補完（例: 四つ打ち＝毎拍キック）。スネア／クラップ判定の後に行い、重なりを見送りの根拠に使う。
  const patternGrid = reinforce ? reinforceKicksByGrid(kicks, lKick, floorKick, hopSec, beats, TH, stereo, snares) : { applied: false, reason: "disabled" };
  kicks.sort((a, b) => a.t - b.t);
  return { kicks, snares, hats, sensitivity: Number(sensitivity) || 3, patternGrid };
}

/**
 * キック自身の並びの周期性（四つ打ち等）を見て、抜けている位置だけゆるい閾値で拾い直す。
 * 通常閾値で見つかった確度の高いキックが少なくとも `minKicks` 個あり、かつ拍の並びの中で
 * 実際にキックが乗る周期（毎拍／半分の周期＝1拍おき）がはっきり定まるときだけ動く。
 * 曲の規則性が弱い・キックが少ない場合は何もしない（誤った規則を押し付けない）。
 * `kicks` は破壊的に更新（推定位置を追加）される。返り値は診断用のメタ情報。
 */
function reinforceKicksByGrid(kicks, lKick, floorKick, hopSec, beats, TH, stereo, snares = []) {
  const minKicks = 6, tol = 0.05, minMatchRatio = 0.35;
  const localWindowSec = 4, localMinRatio = 0.5;   // 前後4秒で格子の半分以上に本物のキックが乗っている区間だけ復元する
  // クラップ／スネアの判定が重なる位置は、低域の証拠が通常閾値に届かない限り復元しない（クラップの低域の漏れを拾わないため）
  if (!Array.isArray(beats) || beats.length < 8 || kicks.length < minKicks) return { applied: false, reason: "insufficient-data" };
  const near = (t, list) => list.some((k) => Math.abs(k.t - t) <= tol);
  const matchCount = (grid) => grid.filter((t) => near(t, kicks)).length;
  // 候補: 毎拍（四つ打ち）／1拍おき（半分の周期・位相2通り）。
  // 「一致率」だけで選ぶと、まばらな格子（1拍おき）が既知のキックだけを拾って見かけ上100%になり、
  // 本当は毎拍鳴っている密な格子（四つ打ち）を過小評価してしまう。密な格子を不当に不利にしないよう、
  // 一致率は「規則性として信じてよいか」の足切りにだけ使い、選択は一致した実数（matchCount）を優先する。
  const everyBeat = beats.slice();
  const everyOtherA = beats.filter((_, i) => i % 2 === 0);
  const everyOtherB = beats.filter((_, i) => i % 2 === 1);
  const candidates = [
    { mode: "every-beat", grid: everyBeat },
    { mode: "every-other-beat", grid: everyOtherA },
    { mode: "every-other-beat", grid: everyOtherB },
  ].map((c) => ({ ...c, matched: matchCount(c.grid), ratio: c.grid.length ? matchCount(c.grid) / c.grid.length : 0 }))
    .filter((c) => c.ratio >= minMatchRatio);
  if (!candidates.length) return { applied: false, reason: "weak-periodicity" };
  candidates.sort((a, b) => b.matched - a.matched);
  const best = candidates[0];
  // 選んだ格子のうち、既存キックが無い位置だけ、通常よりゆるい閾値（半分程度）で拾い直す
  const lenient = { rise: TH.kickRise * 0.5, decay: TH.kickDecay * 0.5, floor: TH.kickFloor * 0.5 };
  const fr = (sec) => Math.max(1, Math.round(sec / hopSec));
  let recovered = 0, skippedLocal = 0, skippedClap = 0;
  const confirmed = kicks.slice();   // 復元前の（通常閾値で見つかった）キック。局所密度はこれだけで測る
  const localRatio = (t) => { const g = best.grid.filter((x) => Math.abs(x - t) <= localWindowSec); return g.length ? g.filter((x) => near(x, confirmed)).length / g.length : 0; };
  for (const t of best.grid) {
    if (near(t, kicks)) continue;
    if (localRatio(t) < localMinRatio) { skippedLocal += 1; continue; }
    const i = Math.round(t / hopSec);
    if (i < fr(0.03) || i + fr(0.2) >= lKick.length) continue;
    let pk = i, pkV = lKick[i];
    for (let j = Math.max(0, i - fr(0.02)); j <= Math.min(lKick.length - 1, i + fr(0.06)); j++) if (lKick[j] > pkV) { pkV = lKick[j]; pk = j; }
    if (pkV - floorKick < lenient.floor) continue;
    const before = Math.min(lKick[Math.max(0, pk - fr(0.03))], lKick[Math.max(0, pk - fr(0.02))]);
    const rise = pkV - before;
    if (rise < lenient.rise) continue;
    const after = lKick[Math.min(lKick.length - 1, pk + fr(0.2))];
    const decay = pkV - after;
    if (decay < lenient.decay) continue;
    if (snares.some((sn) => Math.abs(sn.t - t) <= 0.04) && rise < TH.kickRise) { skippedClap += 1; continue; }
    kicks.push({
      t: round3(pk * hopSec), strength: round3(Math.min(1, rise / (TH.kickRise || 1))), confidence: round3(Math.min(0.6, 0.3 + 0.15 * Math.min(1, decay / 12))),
      pan: panAt(stereo, pk * hopSec, 40, 120), detail: { riseDb: round1(rise), decayDb: round1(decay), peakDb: round1(pkV - floorKick), patternConfirmed: true },
    });
    recovered += 1;
  }
  return { applied: recovered > 0, mode: best.mode, matchRatio: round3(best.ratio), gridSize: best.grid.length, recovered, skippedLocal, skippedClap };
}

/** パン位置: 時刻 t から 60ms の窓で、帯域 [hzLo,hzHi] の L/R エネルギー比。−1=左 … 0=中央 … +1=右。stereo が無ければ 0。 */
export function panAt(stereo, t, hzLo, hzHi) {
  if (!stereo || !stereo.left || !stereo.right) return 0;
  const { left, right, sampleRate } = stereo;
  const n = 2048, start = Math.max(0, Math.round(t * sampleRate) - 128);
  const re = new Float32Array(n), im = new Float32Array(n), re2 = new Float32Array(n), im2 = new Float32Array(n);
  for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); re[i] = (left[start + i] || 0) * w; re2[i] = (right[start + i] || 0) * w; }
  fftInPlace(re, im); fftInPlace(re2, im2);
  const hzPerBin = sampleRate / n, lo = Math.max(1, Math.floor(hzLo / hzPerBin)), hi = Math.min(n / 2, Math.ceil(hzHi / hzPerBin));
  let eL = 0, eR = 0;
  for (let k = lo; k <= hi; k++) { eL += re[k] * re[k] + im[k] * im[k]; eR += re2[k] * re2[k] + im2[k] * im2[k]; }
  if (eL + eR <= 1e-12) return 0;
  return Math.round(((eR - eL) / (eL + eR)) * 100) / 100;
}

/** 判定結果を Feature Timeline の events へ統合する（既存 onset があれば tags を置き換え、無ければ onset を追加）。 */
export function mergeDrumsIntoEvents(ft, drums, { mergeSec = 0.03 } = {}) {
  const onsets = ft.events.filter((e) => e.type === "onset");
  const bands = ft.bands;
  const setTag = (list, name, band) => {
    for (const d of list) {
      let target = null, best = mergeSec + 1e-9;
      for (const o of onsets) { const dt = Math.abs(o.t - d.t); if (dt <= best) { best = dt; target = o; } }
      const tag = { name, confidence: d.confidence, strength: d.strength, source: "drums-v1", ...(d.detail && d.detail.patternConfirmed ? { patternConfirmed: true } : {}), ...(d.detail && d.detail.band ? { band: d.detail.band } : {}) };
      if (target) { target.tags = (target.tags || []).filter((x) => x.name !== name); target.tags.push(tag); if (d.pan !== undefined) target.pan = d.pan; }
      else {
        const ev = { t: d.t, type: "onset", strength: d.strength, band, bands: Object.fromEntries(bands.map((b) => [b.id, b.id === band ? 1 : 0])), confidence: d.confidence, tags: [tag], ...(d.pan !== undefined ? { pan: d.pan } : {}) };
        ft.events.push(ev); onsets.push(ev);
      }
    }
  };
  setTag(drums.kicks, "kick", "bass");
  setTag(drums.snares, "snare", "lowmid");
  setTag(drums.hats, "hat", "air");
  // 打楽器判定が付いた onset の旧ヒューリスティック kick/snare/hat（source 無し）は落とす。判定に外れた onset の推定タグも落とす
  for (const o of onsets) if (o.tags) { o.tags = o.tags.filter((x) => x.source === "drums-v1" || !["kick", "snare", "hat"].includes(x.name)); if (!o.tags.length) delete o.tags; }
  ft.events.sort((a, b) => a.t - b.t || a.type.localeCompare(b.type));
  ft.drums = { version: 1, sensitivity: drums.sensitivity ?? 3, counts: { kick: drums.kicks.length, snare: drums.snares.length, hat: drums.hats.length }, patternGrid: drums.patternGrid || null };
  return ft;
}

function round3(v) { return Math.round(v * 1000) / 1000; }
function round1(v) { return Math.round(v * 10) / 10; }

/** 拍格子を打楽器で補正する。キック＋スネア（8個以上）を「拍に乗る音」として、
 *  テンポの倍・半分・そのままの3候補 × 位相（半周期の範囲）から一致率が最大の格子を選ぶ。
 *  一致率 0.5 未満なら元の格子を保つ。beats / downbeats / bpm / barConfidence を書き換える。 */
export function refineGridWithDrums(ft, drums, { tolSec = 0.04 } = {}) {
  const anchors = [...drums.kicks, ...drums.snares].map((d) => d.t).sort((a, b) => a - b);
  const beats = ft.tempo.beats;
  if (anchors.length < 8 || beats.length < 4) return { shiftSec: 0, agreement: 0, applied: false };
  const dur = ft.source.durationSec, bpm0 = ft.tempo.bpm, phase0 = beats[0].t;
  const agreementOf = (period, phase) => {
    let s = 0;
    for (const a of anchors) { const k = Math.round((a - phase) / period); const d = Math.abs(phase + k * period - a); if (d <= tolSec) s += 1 - d / tolSec * 0.5; }
    return s / anchors.length;
  };
  let best = { mult: 1, shift: 0, agreement: agreementOf(60 / bpm0, phase0) };
  for (const mult of [0.5, 1, 2]) {
    const bpm = bpm0 * mult; if (bpm < 50 || bpm > 220) continue;
    const period = 60 / bpm;
    for (let shift = -period / 2; shift <= period / 2; shift += 0.005) {
      let ag = agreementOf(period, phase0 + shift);
      if (bpm < 90 || bpm > 180) ag *= 0.9;                       // 極端なテンポは少し不利にする
      if (ag > best.agreement + 1e-6) best = { mult, shift, agreement: ag };
    }
  }
  const result = { shiftSec: Math.round(best.shift * 1000) / 1000, mult: best.mult, agreement: Math.round(best.agreement * 1000) / 1000, applied: false };
  if (best.agreement < 0.5 || (best.mult === 1 && Math.abs(best.shift) < 0.005)) { result.applied = false; return result; }
  const bpm = bpm0 * best.mult, period = 60 / bpm;
  let t0 = phase0 + best.shift; while (t0 - period >= 0) t0 -= period; while (t0 < 0) t0 += period;
  const next = [];
  for (let t = t0, index = 0; t < dur; t += period, index++) next.push({ t: Math.round(t * 1000) / 1000, index, bar: 0, beatInBar: index % 4, strength: 0.5 });
  ft.tempo.beats = next; ft.tempo.bpm = Math.round(bpm * 1000) / 1000; ft.tempo.grid = "fixed";
  result.applied = true;
  // 小節頭: キックが最も多く乗る拍位置を1拍目に（スネアが2・4に乗る型も加点）
  const counts = [0, 0, 0, 0];
  for (const b of next) { if (drums.kicks.some((k) => Math.abs(k.t - b.t) <= tolSec)) counts[b.beatInBar] += 1; if (drums.snares.some((k) => Math.abs(k.t - b.t) <= tolSec)) counts[(b.beatInBar + 3) % 4] += 0.5; }
  const bestPos = counts.indexOf(Math.max(...counts));
  if (counts[bestPos] > 0) {
    for (const b of next) b.beatInBar = ((b.beatInBar - bestPos) % 4 + 4) % 4;
    const sorted = [...counts].sort((a, b) => b - a);
    ft.tempo.barConfidence = Math.round(Math.max(0, (sorted[0] - sorted[1]) / sorted[0]) * 1000) / 1000;
  }
  const firstDown = next.findIndex((b) => b.beatInBar === 0);
  next.forEach((b, k) => { b.bar = Math.floor((k - firstDown + 4) / 4) - 1; });
  ft.tempo.downbeats = next.filter((b) => b.beatInBar === 0).map((b) => b.t);
  ft.tempo.gridRefinedBy = "drums-v1";
  return result;
}
