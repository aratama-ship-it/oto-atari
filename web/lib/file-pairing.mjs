// file-pairing.mjs — 1回の選択（またはドラッグ）で受け取ったファイルから、同じ名前の音源と解析 JSON を組にする（TOKEN_SHEET §45・2026-10-08）。
// ブラウザは選ばれていないファイルを読めないので、「まとめて受け取ったものの中で組にする」。
//   音源 <名前>.<拡張子>  ↔  JSON <名前>.features.json ／ <名前>.<種類>.features.json ／ <名前>.json
//   比較は NFKC（全角・半角をそろえる）＋小文字。同じ音源に JSON が複数あれば stem → 種類なし → その他（名前順）。
const AUDIO_EXT = /\.(mp3|wav|wave|m4a|aac|aif|aiff|flac|ogg|oga|opus|caf|mp4|webm)$/i;
export const normName = (s) => String(s).normalize("NFKC").toLowerCase();
export const isAudioFile = (f) => (typeof f.type === "string" && f.type.startsWith("audio/")) || AUDIO_EXT.test(f.name);
export const isJsonFile = (f) => /\.json$/i.test(f.name) || f.type === "application/json";
export const audioBase = (name) => name.replace(/\.[^.]+$/, "");
/** JSON の名前から拡張子部分を外した残り（例: "Percussive Breaks.stem-guitar.features.json" → "Percussive Breaks.stem-guitar"）。 */
export const jsonStem = (name) => name.replace(/\.features\.json$/i, "").replace(/\.json$/i, "");
const rank = (variant) => (variant === "stem" ? 0 : variant === "" ? 1 : 2);

/**
 * @param {Array<{name:string,type?:string}>} files  File（またはそれに似たもの）の配列
 * @returns {{ songs: Array<{ key:string, label:string, base:string, audio:any, json:any|null, variant:string|null }>, jsonOnly: any[] }}
 */
export function pairFiles(files) {
  const audios = files.filter(isAudioFile).sort((a, b) => audioBase(a.name).localeCompare(audioBase(b.name), "ja"));
  const jsons = files.filter((f) => !isAudioFile(f) && isJsonFile(f));
  const bases = audios.map((a) => ({ a, base: audioBase(a.name), n: normName(audioBase(a.name)) }));
  const byAudio = new Map(bases.map((b) => [b.a, []]));
  const jsonOnly = [];
  for (const j of jsons) {
    const s = normName(jsonStem(j.name));
    // いちばん長く一致する音源の名前に付ける（"A" と "A.remix" の両方があるとき "A.remix.stem" は後者へ）
    let best = null;
    for (const b of bases) if ((s === b.n || s.startsWith(b.n + ".")) && (!best || b.n.length > best.n.length)) best = b;
    if (!best) { jsonOnly.push(j); continue; }
    const variant = s === best.n ? "" : jsonStem(j.name).slice(best.base.length + 1);
    byAudio.get(best.a).push({ j, variant });
  }
  const songs = [];
  for (const { a, base } of bases) {
    const list = byAudio.get(a).sort((x, y) => rank(normName(x.variant)) - rank(normName(y.variant)) || x.variant.localeCompare(y.variant, "ja"));
    if (!list.length) { songs.push({ key: `${base}|`, label: `${base}（ブラウザで解析）`, base, audio: a, json: null, variant: null }); continue; }
    list.forEach(({ j, variant }, i) => songs.push({ key: `${base}|${variant}`, label: i === 0 ? base : `${base}（${variant || "解析JSON"}）`, base, audio: a, json: j, variant }));
  }
  return { songs, jsonOnly };
}
