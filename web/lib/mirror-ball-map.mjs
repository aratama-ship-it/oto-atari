// mirror-ball-map.mjs — ミラーボールの「割り振り」（DOM・描画なしの純粋関数）。
// 規則: 持続音 → 球を回す／拍（キック・スネア、無ければ拍）→ ピンの点滅。
// 数値の正本は design/TOKEN_SHEET.md §25。描画は renderers/stage3d.mjs が γ の共有部品（vendor/gamma）へ渡す。
// すべて時刻 t の関数（シーク・停止・再開で同じ絵）。持続音の区間は曲ごとに1回だけ前計算する。

export const MIRROR_MAP = Object.freeze({
  // 持続音の検出（Feature Timeline の連続量から）。ヒューリスティックで、楽器名の判定ではない。
  sustainBands: Object.freeze(["band.lowmid", "band.mid"]), // ドラム（sub/bass=キック・high/air=ハット）が主に占めない帯域
  sustainWindowSec: 0.4,   // この窓の「最小値」が閾値以上＝途切れず鳴り続けている
  sustainLevel: 0.2,       // 帯域ごとに曲全体で 0〜1 へ正規化済みの値に対する閾値
  sustainMinSec: 1.0,      // これより短い区間は持続音と見なさない
  sustainMergeGapSec: 0.4, // 区間の間がこれ以下なら1つにつなぐ
  noteMinDurSec: 0.5,      // note 候補（ピアノ推定）のうち、この長さ以上は余韻も持続音として足す
  rampSec: 0.8,            // 回り始め・止まりの滑らかさ（モーターの加減速）
  trackHopSec: 0.02,       // 前計算の刻み
  // ピン（球を照らす2灯）
  pinBase: 0.5,            // 回っている間のピンの常時の明るさ（0〜1）。拍の閃光はこの上に重なる
  flashSec: 0.2,           // 拍の閃光の長さ
  flashPower: 2,           // 閃光の減衰の鋭さ（残り割合^power）
  beatStrength: Object.freeze({ down: 0.9, other: 0.6 }), // 拍フォールバック時の閃光の強さ（小節頭／その他）
});

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const finite = (v, d) => Number.isFinite(Number(v)) ? Number(v) : d;

/** 窓内の最小値（スライディング最小・O(n)）。窓は中心揃え。端は端の値で延長。 */
export function runningMin(values, windowFrames) {
  const n = values.length, w = Math.max(1, Math.round(windowFrames));
  const out = new Float32Array(n);
  const half = Math.floor(w / 2), deque = [];
  let next = 0; // 次に deque へ入れる添字
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + w - 1 - half);
    for (; next <= hi; next++) {
      while (deque.length && values[deque[deque.length - 1]] >= values[next]) deque.pop();
      deque.push(next);
    }
    const lo = Math.max(0, i - half);
    while (deque.length && deque[0] < lo) deque.shift();
    // 端（窓が曲の外へはみ出す部分）は端の値で延長したものと同じ＝窓内の実在サンプルの最小で足りる
    out[i] = values[deque[0]];
  }
  return out;
}

const mergeSpans = (spans, gap) => {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start - last.end <= gap) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
};

/**
 * 持続音の区間 [{start,end}]（秒・昇順・重ならない）。純粋関数。
 * 1) 連続量 band.lowmid / band.mid のどちらかが、窓 sustainWindowSec の間ずっと sustainLevel 以上 → 区間（実際に鳴っていた長さが sustainMinSec 以上だけ。窓より短い音・刻みは落ちる）
 * 2) note 候補（ピアノ推定）の dur が noteMinDurSec 以上 → [t, t+dur]
 * 3) 無音（silence）は除く。近い区間はつなぐ。
 */
export function sustainSpans(ft, opts = {}) {
  const M = { ...MIRROR_MAP, ...opts };
  const out = [];
  const hop = finite(ft?.clock?.hopSec, 0);
  const duration = finite(ft?.source?.durationSec, 0);
  if (hop > 0 && ft?.curves) {
    for (const id of M.sustainBands) {
      const curve = ft.curves[id];
      if (!Array.isArray(curve) || curve.length < 2) continue;
      const min = runningMin(curve, M.sustainWindowSec / hop);
      let start = -1;
      for (let i = 0; i <= min.length; i++) {
        const on = i < min.length && min[i] >= M.sustainLevel;
        if (on && start < 0) start = i;
        if (!on && start >= 0) {
          // 最小値の窓（erosion）で縮んだ区間。窓の半分ずつ両端へ戻すと実際に鳴っていた長さ（opening）になる。
          const a = start * hop - M.sustainWindowSec / 2, b = i * hop + M.sustainWindowSec / 2;
          if (b - a >= M.sustainMinSec) out.push({ start: Math.max(0, a), end: b });
          start = -1;
        }
      }
    }
  }
  for (const e of ft?.events || []) {
    if (e.type === "note" && finite(e.dur, 0) >= M.noteMinDurSec) out.push({ start: e.t, end: e.t + e.dur });
  }
  let spans = mergeSpans(out, M.sustainMergeGapSec);
  const silences = (ft?.events || []).filter((e) => e.type === "silence" && finite(e.dur, 0) > 0)
    .map((e) => ({ start: e.t, end: e.t + e.dur })).sort((a, b) => a.start - b.start);
  for (const s of silences) {
    spans = spans.flatMap((p) => {
      if (s.end <= p.start || s.start >= p.end) return [p];
      const parts = [];
      if (s.start > p.start) parts.push({ start: p.start, end: s.start });
      if (s.end < p.end) parts.push({ start: s.end, end: p.end });
      return parts;
    });
  }
  if (duration > 0) spans = spans.map((p) => ({ start: clamp(p.start, 0, duration), end: clamp(p.end, 0, duration) })).filter((p) => p.end > p.start);
  return spans;
}

/**
 * 回転の前計算。spans の中では目標が 1、外では 0。実際の速さ env は rampSec で滑らかに追従（毎ステップの変化量を制限）。
 * 角度は env×rpm の積分＝止まっても位置を保ち、動き出しは前の角度から続く。時刻の関数なのでシークしても同じ。
 * 返す track = { hopSec, env:Float32Array(0..1), phase:Float32Array(度), rpm }。
 */
export function buildSpinTrack(spans, { durationSec, rpm = 1, rampSec = MIRROR_MAP.rampSec, hopSec = MIRROR_MAP.trackHopSec } = {}) {
  const n = Math.max(2, Math.ceil(finite(durationSec, 0) / hopSec) + 2);
  const env = new Float32Array(n), phase = new Float32Array(n);
  const list = Array.isArray(spans) ? spans : [];
  const step = hopSec / Math.max(1e-3, rampSec), degPerSec = finite(rpm, 0) * 6; // 1rpm = 6°/s
  let k = 0, e = 0, deg = 0;
  for (let i = 0; i < n; i++) {
    const t = i * hopSec;
    while (k < list.length && list[k].end <= t) k++;
    const target = k < list.length && list[k].start <= t ? 1 : 0;
    e = e < target ? Math.min(target, e + step) : Math.max(target, e - step);
    env[i] = e; phase[i] = deg; deg += degPerSec * e * hopSec;
  }
  return { hopSec, env, phase, rpm: finite(rpm, 0) };
}

/** 時刻 t の回転の速さ（0〜1・rpm に掛ける割合）と角度（度）。track が無ければ止まった球。 */
export function spinAt(track, t) {
  if (!track || !track.env || track.env.length < 2) return { env: 0, phaseDeg: 0 };
  const x = clamp(finite(t, 0) / track.hopSec, 0, track.env.length - 1);
  const i = Math.min(track.env.length - 2, Math.floor(x)), f = x - i;
  const env = track.env[i] + (track.env[i + 1] - track.env[i]) * f;
  // 区間内は env が滑らかなので角度は線形補間で足りる（刻み 20ms・最大 6°/s×… の誤差は 0.01° 未満）
  return { env, phaseDeg: track.phase[i] + (track.phase[i + 1] - track.phase[i]) * f };
}

const lowerBound = (arr, t) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; } return lo; };

/**
 * ピン2灯の拍の閃光（0〜1）。pins[0]＝キック（無ければ拍の表・偶数拍）、pins[1]＝スネア（無ければ裏拍）。
 * キック／スネアがどちらも無い曲（ピアノ等）だけ拍へフォールバックする。時刻 t 以前の打点しか見ない（未来は不使用）。
 */
export function pinFlashAt(t, data, opts = {}) {
  const M = { ...MIRROR_MAP, ...opts };
  const out = [0, 0];
  if (!data) return out;
  const hits = data.hits || [];
  const hasDrums = hits.some((h) => h.tag === "kick" || h.tag === "snare");
  const life = (age, strength) => {
    if (!(age >= 0 && age < M.flashSec)) return 0;
    return (1 - age / M.flashSec) ** M.flashPower * clamp(strength, 0, 1);
  };
  if (hasDrums) {
    for (let i = lowerBound(hits, t - M.flashSec); i < hits.length; i++) {
      const h = hits[i]; if (h.t > t) break;
      const slot = h.tag === "kick" ? 0 : h.tag === "snare" ? 1 : -1;
      if (slot < 0) continue;
      out[slot] = Math.max(out[slot], life(t - h.t, finite(h.level, 0.5)));
    }
  } else {
    const beats = data.beats || [];
    for (let i = lowerBound(beats, t - M.flashSec); i < beats.length; i++) {
      const b = beats[i]; if (b.t > t) break;
      const slot = (b.beatInBar | 0) % 2 === 0 ? 0 : 1;
      out[slot] = Math.max(out[slot], life(t - b.t, b.beatInBar === 0 ? M.beatStrength.down : M.beatStrength.other));
    }
  }
  return out;
}

/**
 * ピン2灯の明るさ（0〜100）。回っている間は常時 pinBase（×回転の速さ）、そこへ拍の閃光が重なる。
 * 無音（silence）の間は0。spin01 は spinAt().env。
 */
export function pinLevelsAt(t, data, spin01 = 0, opts = {}) {
  const M = { ...MIRROR_MAP, ...opts };
  if (!data || (data.cues || []).some((c) => c.type === "silence" && t >= c.t && t <= c.t + c.dur)) return [0, 0];
  const base = M.pinBase * clamp(finite(spin01, 0), 0, 1);
  return pinFlashAt(t, data, M).map((flash) => Math.round(clamp(Math.max(base, flash), 0, 1) * 1000) / 10);
}
