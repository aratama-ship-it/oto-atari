// 音源を使わないUIデモ。解析した打点ではなく、明示的に組んだ16秒のパターン。
// 既存の特徴→割り振り→意図を通すので、どの表示でも同じ時刻を使える。
export function createDemoFeatures() {
  const durationSec = 16, hopSec = 0.05, frames = durationSec / hopSec;
  const bands = [
    ["sub", 20, 60], ["bass", 60, 160], ["lowmid", 160, 500],
    ["mid", 500, 2000], ["high", 2000, 6000], ["air", 6000, 20000],
  ].map(([id, low, high]) => ({ id, hz: [low, high] }));
  const events = [];
  const hit = (t, tag, band, strength, pan = 0) => events.push({
    t, type: "onset", band, strength, confidence: 1, pan, tags: [{ name: tag, confidence: 1 }],
  });
  for (let bar = 0; bar < 8; bar++) {
    const subdivisions = [2, 2, 3, 4][bar % 4];
    for (let beat = 0; beat < 4; beat++) {
      const t = bar * 2 + beat * 0.5;
      hit(t, "kick", "bass", beat % 2 ? 0.7 : 1);
      if (beat % 2) hit(t, "snare", "mid", 0.85, bar % 2 ? 0.35 : -0.35);
      for (let step = 0; step < subdivisions; step++) {
        hit(t + step * 0.5 / subdivisions, "hat", "air", step ? 0.55 : 0.8, step % 2 ? 0.6 : -0.6);
      }
    }
  }
  events.sort((a, b) => a.t - b.t);
  const curve = (select) => Array.from({ length: frames }, (_, i) =>
    Math.min(1, events.filter(select).reduce((level, e) => {
      const age = i * hopSec - e.t;
      return Math.max(level, age >= 0 && age < 0.4 ? e.strength * (1 - age / 0.4) : 0);
    }, 0)));
  const curves = { loudness: curve(() => true), centroid: Array(frames).fill(0.5), flux: curve(() => true), bandGain: {} };
  for (const { id } of bands) { curves[`band.${id}`] = curve((e) => e.band === id); curves.bandGain[id] = 1; }
  const beats = Array.from({ length: 32 }, (_, i) => ({ t: i * 0.5, beatInBar: i % 4 }));
  return {
    format: "oto-atari.feature-timeline", version: 1,
    source: { file: "built-in-light-demo", durationSec, analyzer: { name: "合成パターン（音源解析なし）", version: "1" } },
    clock: { hopSec, frames }, bands,
    tempo: { bpm: 120, confidence: 1, barConfidence: 1, grid: "fixed", beats, downbeats: beats.filter((b) => b.beatInBar === 0).map((b) => b.t) },
    sections: [{ id: "demo", start: 0, end: durationSec, label: "光のデモ · 無音" }],
    curves, events,
  };
}
