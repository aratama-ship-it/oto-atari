// zones.mjs — 抽象 zone を各出力先の幾何へ翻訳するための共通部品。
export const VERTICAL = ["floor", "low", "mid", "high", "air"];
export const HORIZONTAL = ["left", "center", "right"];

export function zoneParts(zone) {
  const list = Array.isArray(zone) ? zone : [zone || "all"];
  const v = list.find((z) => VERTICAL.includes(z)) || null;
  const h = list.find((z) => HORIZONTAL.includes(z)) || null;
  return { v, h, all: list.includes("all") || (!v && !h) };
}

/** 縦 zone → [y0, y1]（0=上端, 1=下端）。画面上の帯。 */
export function verticalBand(v) {
  const i = VERTICAL.indexOf(v);
  if (i < 0) return [0, 1];
  // floor は下端の薄い帯、air は上端の薄い帯。中間3つを均等ではなく少し中央寄せ。
  const edges = [1.0, 0.86, 0.62, 0.38, 0.14, 0.0];
  return [edges[i + 1], edges[i]];
}
export function horizontalBand(h) {
  if (h === "left") return [0, 0.34];
  if (h === "right") return [0.66, 1];
  if (h === "center") return [0.33, 0.67];
  return [0, 1];
}
