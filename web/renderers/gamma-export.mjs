// gamma-export.mjs — Intent Timeline → 舞台スケッチγ の照明データ（下書き）。
// 入力の雛形は γ から書き出した「ショーJSON」（project.lightingDesign を含む）または「照明デザインJSON」（format: shosai.light-design）。
// 雛形の灯体（rig.fixtures / rig.bindings.groups）に対して、音楽の区切り・落とし・無音の時刻に「登録した明かり（lxq）」を作り、
// ショーJSONのときは同じ時刻に timeline のライトキュー（cueType:"light"）も足す。原本は変更せず、新しい文書を返す。
// ※ γ 本体での読み込み確認はまだ。構造は 2026-09-17 の書き出し実物に合わせている（tests/fixtures/sample-lightdesign.json）。
import { discreteBetween, continuousAt, paletteColorAt } from "../lib/mapping-engine.mjs";
import { ZONE_TO_GROUPS } from "./rig.mjs";
import { zoneParts } from "./zones.mjs";

const GROUP_ORDER = ["FL", "SL", "SH", "WASH", "CL", "B1", "B2", "B3", "BACK", "CY"];

export function detectTemplate(doc) {
  if (doc && doc.project && doc.project.lightingDesign) return { kind: "show", design: doc.project.lightingDesign, project: doc.project };
  if (doc && doc.format === "shosai.light-design") return { kind: "design", design: doc, project: null };
  throw new Error("雛形が読めません。γのショーJSON（project.lightingDesign あり）か照明デザインJSON（format: shosai.light-design）を渡してください");
}

/** キューを置く時刻の候補: 区切り・落とし・ビルド開始・無音・ストロボ。先頭は必ず 0 秒。 */
export function cueTimes(ft, it, { includeStrobes = true, minGapSec = 1.0 } = {}) {
  const times = [{ t: 0, label: "頭", kind: "start" }];
  for (const s of (ft.sections || []).slice(1)) times.push({ t: s.start, label: `区切り ${s.label}`, kind: "section" });
  for (const e of ft.events || []) {
    if (e.type === "drop") times.push({ t: e.t, label: "落とし", kind: "drop" });
    if (e.type === "build") times.push({ t: e.t, label: "上昇", kind: "build" });
    if (e.type === "silence") times.push({ t: e.t, label: "無音", kind: "silence" });
  }
  if (includeStrobes) for (const d of it.discrete) if (d.intent === "strobe" && d.dur >= 0.5) times.push({ t: d.t, label: "ストロボ", kind: "strobe" });
  times.sort((a, b) => a.t - b.t);
  const out = [];
  for (const x of times) { if (!out.length || x.t - out[out.length - 1].t >= minGapSec) out.push(x); else if (x.kind === "section") out[out.length - 1] = x; }
  return out;
}

/** 時刻 t のグループ別状態（純関数。描画クラスに依存しない）。 */
export function groupStatesAt(it, t, { window = 0.25 } = {}) {
  const states = new Map(GROUP_ORDER.map((g) => [g, { level: 0, color: null, strobe: null }]));
  const groupsFor = (zone) => { const { v, all } = zoneParts(zone); return all ? ZONE_TO_GROUPS.all : (ZONE_TO_GROUPS[v] || ZONE_TO_GROUPS.all); };
  for (const c of continuousAt(it, t)) {
    if (c.intent !== "wash") continue;
    for (const g of groupsFor(c.zone)) { const s = states.get(g); if (c.level > s.level) { s.level = c.level; s.color = c.color || s.color; } }
  }
  for (const d of discreteBetween(it, t - 0.02, t + window)) {
    if (d.intent === "splat" || d.intent === "pulse") {
      const lv = d.intent === "splat" ? (d.size ?? 0.5) * 0.8 : (d.level ?? 0.3);
      for (const g of groupsFor(d.zone)) { const s = states.get(g); if (lv > s.level) { s.level = lv; s.color = d.color || s.color; } }
    }
    if (d.intent === "strobe" && d.t <= t + 0.02) for (const g of groupsFor(d.zone)) { const s = states.get(g); s.strobe = { hz: d.hz ?? 8, duty: d.duty ?? 0.5 }; s.level = Math.max(s.level, 1); s.color = d.color || s.color; }
    if (d.intent === "blackout" && d.t <= t + 0.02) for (const s of states.values()) { s.level = 0; }
  }
  const haze = continuousAt(it, t).find((c) => c.intent === "haze");
  return { states, haze: haze ? Math.round(haze.level * 100) : 35 };
}

const fixtureDefaults = (fixture, aim) => ({
  on: false, level: 0, color: "#f2ead6", surface: "floor",
  path: { kind: "still", a: aim ? { u: aim.u ?? 0.5, v: aim.v ?? 0.5, hM: aim.hM ?? 0 } : { u: 0.5, v: 0.5, hM: 0 } },
  speed: "normal", periodSec: null, offsetSec: 0, levelTo: null, beamDegTo: null, beamDeg: null,
  gobo: "none", goboSoft: 6, goboSpin: 0, goboAngle: 0, strobe: null, shutter: null, glare: 1, groupId: null,
});

/**
 * 主関数。返り値 { document, summary }。document は雛形の深い複製に lxq／cues を足したもの。
 * options.sceneId: ショーJSONのとき対象シーン。省略時は lightingDesign.scenes の先頭。
 */
export function buildGammaDraft(template, ft, it, options = {}) {
  if (it?.discrete?.some((d) => d.intent === "point")) throw new Error("単音の位置指定はγ下書きへ未対応です");
  const { kind, design: designRef } = detectTemplate(template);
  const doc = JSON.parse(JSON.stringify(template));
  const design = kind === "show" ? doc.project.lightingDesign : doc;
  const scenes = Array.isArray(design.scenes) ? design.scenes : [];
  if (!scenes.length) throw new Error("雛形に照明シーンがありません");
  const scene = (options.sceneId && scenes.find((s) => s.id === options.sceneId)) || scenes[0];
  const groups = (design.rig && design.rig.bindings && design.rig.bindings.groups) || {};
  const defaultAim = (design.rig && design.rig.bindings && design.rig.bindings.defaultAim) || {};
  const fixtures = (design.rig && design.rig.fixtures) || [];
  const baseLights = (scene.cue && scene.cue.lights) || {};
  const times = cueTimes(ft, it, options);
  const stamp = new Date().toISOString();
  const existingSeq = Array.isArray(scene.lxq) ? scene.lxq.length : 0;
  const lx = scene.lx || { section: 1, no: 1 };
  const lxq = [];
  const memoLines = [];
  times.forEach((row, k) => {
    const { states, haze } = groupStatesAt(it, row.t);
    const lights = {};
    for (const f of fixtures) lights[f.id] = baseLights[f.id] ? JSON.parse(JSON.stringify(baseLights[f.id])) : fixtureDefaults(f, defaultAim[f.id]);
    const litGroups = [];
    for (const [gid, st] of states) {
      const members = groups[gid] || [];
      if (!members.length) continue;
      if (st.level < 0.05) { for (const fid of members) if (lights[fid]) { lights[fid].on = false; lights[fid].level = 0; lights[fid].strobe = null; } continue; }
      litGroups.push(`${gid} ${Math.round(st.level * 100)}%${st.strobe ? ` ⚡${st.strobe.hz}Hz` : ""}`);
      for (const fid of members) {
        const L = lights[fid]; if (!L) continue;
        L.on = true; L.level = Math.round(st.level * 100); L.levelTo = null;
        if (st.color) L.color = st.color;
        L.strobe = st.strobe ? { on: true, kind: "sharp", hz: Math.max(1, Math.min(16, Math.round(st.strobe.hz))), duty: Math.round((st.strobe.duty ?? 0.5) * 100), phaseNorm: 0 } : null;
      }
    }
    const seq = existingSeq + k + 1;
    const name = `${row.label} ${fmtTime(row.t)}`.slice(0, 24);
    lxq.push({ id: `oto-atari-lxq-${scene.id}-${seq}`, seq, name, at: stamp, cue: { lights, groups: [], environment: { haze } },
      otoAtari: { t: row.t, kind: row.kind, source: it.source && it.source.file, mapping: it.source && it.source.mapping } });
    memoLines.push({ t: row.t, memo: `音アタリ LX ${lx.section}-${lx.no}-${seq} ${row.label}: ${litGroups.length ? litGroups.join(" / ") : "全消灯"}` });
  });
  scene.lxq = [...(Array.isArray(scene.lxq) ? scene.lxq : []), ...lxq];
  let cuesAdded = 0;
  if (kind === "show") {
    const cues = Array.isArray(doc.project.cues) ? doc.project.cues : [];
    const ids = new Set(cues.map((c) => c && c.id));
    memoLines.forEach((m, k) => {
      let id = `oto-atari-cue-${scene.id}-${existingSeq + k + 1}`; while (ids.has(id)) id += "-x"; ids.add(id);
      cues.push({ id, kind: "timeline", cueType: "light", sceneId: scene.id, offsetSeconds: Math.round(m.t * 1000) / 1000, memo: m.memo.slice(0, 200), locked: false });
      cuesAdded++;
    });
    doc.project.cues = cues;
  }
  return { document: doc, summary: { kind, sceneId: scene.id, sceneName: scene.name, lxqAdded: lxq.length, cuesAdded, fixtures: fixtures.length, times: times.map((x) => ({ t: x.t, label: x.label })) } };
}

function fmtTime(t) { const m = Math.floor(t / 60), s = (t % 60).toFixed(1).padStart(4, "0"); return `${m}:${s}`; }
