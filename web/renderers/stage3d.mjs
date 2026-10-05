// 舞台表示の投影・照明アダプタ。数値の正本: design/TOKEN_SHEET.md §13・§16〜23・§25。
// γの幾何ブロックは _delegation/gamma-src-2026-10-01/stage-first-person.js から無改変抽出。
import { DRUM_WINDOW } from "./experience.mjs?v=20261005a";
import { drawVocalLaser } from "./vocal-laser.mjs?v=20261005a";
import { spinAt, pinLevelsAt, buildSpinTrack } from "../lib/mirror-ball-map.mjs?v=20261005a";

const W = 12, D = 9, H = 8;
const FIXTURE_OUTLINE_COLOR = "#808080";
// stage-first-person.js L872-875 / L903-910 の既定値。DOMパネル依存は持ち込まない。
let state = { yaw: 180, pitch: -2 };
let canvasWidth = 0, canvasHeight = 0, focal = 1;
let camera = { x: 0, y: 1.35, z: 10.7, me: null };
let forward = { x: 0, y: 0, z: -1 }, right = { x: 1, y: 0, z: 0 }, up = { x: 0, y: 1, z: 0 };

// stage-first-person.js L4-9 NEAR / LENSES
  const NEAR = 0.12;
  const LENSES = Object.freeze([
    Object.freeze({ id: "ultrawide", name: "超広角", fovDeg: 120 }),
    Object.freeze({ id: "wide", name: "広角", fovDeg: 110 }),
    Object.freeze({ id: "normal", name: "標準", fovDeg: 86 }),
  ]);

// stage-first-person.js L63-64 clamp / finite
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

// stage-first-person.js L75-77 focalFor
  function focalFor(width, fovDeg) {
    return (width / 2) / Math.tan(fovDeg * Math.PI / 360);
  }

// stage-first-person.js L156-158 toWorld
  function toWorld(u, v, width, depth, y = 0) {
    return { x: (u - 0.5) * width, y, z: (v - 0.5) * depth };
  }

// stage-first-person.js L400-408 yawForward / rightOf
  function yawForward(degrees) {
    const yaw = finite(degrees, 0) * Math.PI / 180;
    return { x: -Math.sin(yaw), y: 0, z: Math.cos(yaw) };
  }

  function rightOf(forwardOrYaw) {
    const forward = typeof forwardOrYaw === "number" ? yawForward(forwardOrYaw) : forwardOrYaw;
    return { x: -forward.z, y: 0, z: forward.x };
  }

// stage-first-person.js L784-818 clipPolyNear
  function clipPolyNear(points, near = NEAR) {
    if (!Array.isArray(points) || !points.length) return [];
    if (points.length === 2) {
      let a = points[0];
      let b = points[1];
      if (a.z <= near && b.z <= near) return [];
      if (a.z <= near || b.z <= near) {
        const ratio = (near - a.z) / (b.z - a.z);
        const middle = {
          x: a.x + (b.x - a.x) * ratio,
          y: a.y + (b.y - a.y) * ratio,
          z: near,
        };
        if (a.z <= near) a = middle; else b = middle;
      }
      return [a, b];
    }
    const output = [];
    for (let index = 0; index < points.length; index += 1) {
      const a = points[index];
      const b = points[(index + 1) % points.length];
      const aInside = a.z > near;
      const bInside = b.z > near;
      if (aInside) output.push(a);
      if (aInside !== bInside) {
        const ratio = (near - a.z) / (b.z - a.z);
        output.push({
          x: a.x + (b.x - a.x) * ratio,
          y: a.y + (b.y - a.y) * ratio,
          z: near,
        });
      }
    }
    return output;
  }

// stage-first-person.js L1828-1838 setBasis
  function setBasis() {
    const pitchRadians = state.pitch * Math.PI / 180;
    const flat = yawForward(state.yaw);
    forward = { x: flat.x * Math.cos(pitchRadians), y: Math.sin(pitchRadians), z: flat.z * Math.cos(pitchRadians) };
    right = rightOf(flat);
    up = {
      x: right.y * forward.z - right.z * forward.y,
      y: right.z * forward.x - right.x * forward.z,
      z: right.x * forward.y - right.y * forward.x,
    };
  }

// stage-first-person.js L1840-1853 toCamera / toScreen
  function toCamera(point) {
    const dx = point.x - camera.x;
    const dy = point.y - camera.y;
    const dz = point.z - camera.z;
    return {
      x: dx * right.x + dy * right.y + dz * right.z,
      y: dx * up.x + dy * up.y + dz * up.z,
      z: dx * forward.x + dy * forward.y + dz * forward.z,
    };
  }

  function toScreen(point) {
    return { x: canvasWidth / 2 + point.x * focal / point.z, y: canvasHeight / 2 - point.y * focal / point.z };
  }

// stage-first-person.js L1855-1879 fillPoly / line3
  function fillPoly(ctx, worldPoints, fill, stroke, lineWidth) {
    const clipped = clipPolyNear(worldPoints.map(toCamera));
    if (clipped.length < 3) return;
    ctx.beginPath();
    clipped.forEach((point, index) => {
      const screen = toScreen(point);
      if (index) ctx.lineTo(screen.x, screen.y); else ctx.moveTo(screen.x, screen.y);
    });
    ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth || 1; ctx.stroke(); }
  }

  function line3(ctx, a, b, color, width) {
    const clipped = clipPolyNear([toCamera(a), toCamera(b)]);
    if (clipped.length !== 2) return;
    const start = toScreen(clipped[0]);
    const end = toScreen(clipped[1]);
    ctx.beginPath();
    ctx.moveTo(start.x, start.y);
    ctx.lineTo(end.x, end.y);
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    ctx.stroke();
  }

// stage-first-person.js L1897-1913 rayDirAt / groundPointAt
  function rayDirAt(px, py) {
    const a = (px - canvasWidth / 2) / focal;
    const b = (canvasHeight / 2 - py) / focal;
    return {
      x: right.x * a + up.x * b + forward.x,
      y: right.y * a + up.y * b + forward.y,
      z: right.z * a + up.z * b + forward.z,
    };
  }

  function groundPointAt(px, py, planeY) {
    const dir = rayDirAt(px, py);
    if (Math.abs(dir.y) < 1e-6) return null;
    const t = (planeY - camera.y) / dir.y;
    if (t <= 0) return null;
    return { x: camera.x + dir.x * t, z: camera.z + dir.z * t };
  }

// stage-first-person.js L3466-3473 cueLightProjector
  function cueLightProjector() {
    return (point) => {
      const camPoint = toCamera({ x: point.x, y: Math.max(0, point.z || 0), z: (point.y || 0) - D / 2 });
      if (!(camPoint.z > NEAR)) return null;
      const at = toScreen(camPoint);
      return { X: at.x, Y: at.y };
    };
  }

// stage-first-person.js L3478-3494 clipCueLightFloor を基に、音アタリでは奥の壁の面も穴の範囲に含める
// （v0.5.0の奥壁照射用。現在はSSと単音スポットの床面が対象。式は同じ、面を2つ重ねるだけ）
  function clipCueLightSurfaces(maskCtx) {
    if (!maskCtx || !(W > 0) || !(D > 0)) return false;
    const floor = [
      { x: -W / 2, y: 0, z: -D / 2 }, { x: W / 2, y: 0, z: -D / 2 },
      { x: W / 2, y: 0, z: D / 2 }, { x: -W / 2, y: 0, z: D / 2 },
    ];
    const back = [
      { x: -W / 2, y: 0, z: -D / 2 }, { x: W / 2, y: 0, z: -D / 2 },
      { x: W / 2, y: H, z: -D / 2 }, { x: -W / 2, y: H, z: -D / 2 },
    ];
    let any = false;
    maskCtx.beginPath();
    for (const poly of [floor, back]) {
      const clipped = clipPolyNear(poly.map(toCamera));
      if (clipped.length < 3) continue;
      any = true;
      clipped.forEach((point, index) => {
        const at = toScreen(point);
        if (index) maskCtx.lineTo(at.x, at.y); else maskCtx.moveTo(at.x, at.y);
      });
      maskCtx.closePath();
    }
    if (!any) return false;
    maskCtx.clip();
    return true;
  }

// 以下は音アタリ固有のアダプタ（γの抜粋ではない）。
export const STAGE_SIZE = Object.freeze({ W, D, H });
export const VIEWPOINTS = Object.freeze({
  "house-center": Object.freeze({ x: 0, y: 1.35, z: 10.7, yaw: 180, pitch: -2 }),
  "house-front": Object.freeze({ x: 0, y: 1.2, z: 6.5, yaw: 180, pitch: -2 }),
  // γ yawForward は 0°→+z（客席向き）。舞台中央から奥を向くには 180°（Codex 指摘 2026-10-01、指示書の 0° は誤り）。
  // 舞台前縁（エプロン）から奥を見る。舞台中央 z=0〜3.5 だと LED バーの光だまり（床 v=0.5）に入り込み画面が白く飽和した（2026-10-01 実測 全面平均 172）。
  "stage-center": Object.freeze({ x: 0, y: 1.6, z: 4.4, yaw: 180, pitch: 6 }),
  // yawForward(90).x = -1。指示書の「符号は確かめる」に従い上手(+x)へ向ける。
  "wing-shimote": Object.freeze({ x: -7, y: 1.6, z: 0, yaw: -90, pitch: -2 }),
});
const COLORS = Object.freeze({ floor: "#dbe8ff", side: "#ff7e30", truss: "#ffc04e" });
export const STAGE_LIGHT_STYLE = Object.freeze({
  floorBeamDeg: 54, floorAimV: 0.8, floorAimHeight: 3, floorSoftness: 8,
  sideLowBeamDeg: 18, sideHighBeamDeg: 40, sideSoftness: 2,
});
export const STAGE_POINT_STYLE = Object.freeze({
  count: 24, uStart: 0.1, uEnd: 0.9, barHeight: 6.5,
  rows: Object.freeze([Object.freeze({ barV: 0.28, aimV: 0.44 }), Object.freeze({ barV: 0.40, aimV: 0.68 })]),
  beamDeg: 10, softness: 2, color: "#b7f9ec", windowSec: 0.6, decayPower: 1.8,
});
const STAGE_LED_STYLE = Object.freeze({
  length: 0.5, thickness: 0.06, emitterRatio: 0.88, coreWidth: 0.028,
  haloRadius: 0.18, body: "#080c13", edge: "#2c2c30", core: "#fff2d6",
});
// ミラーボール＋ピン2灯（2026-10-04・TOKEN_SHEET §25）。割り振りの純粋関数は lib/mirror-ball-map.mjs。
// 球は舞台中央のバトンから吊り、ピンは同じバトンの両端（下手・上手）から球をほぼ水平に狙う（γ の light.target＝球の id）。
// ピンを客席側や舞台前縁に置くと「舞台中央」視点のカメラの目の前を光の筋が横切り、画面が灰色の帯で埋まる（2026-10-04 実測）。
export const STAGE_MIRROR_STYLE = Object.freeze({
  ballId: "mirror-ball-01", ballNo: 97, ballU: 0.5, diameterM: 0.6, rpm: null, // rpm null＝γの既定（engine.mirrorBallOf）
  ballTruss: Object.freeze({ id: "bar-mirror", v: 0.62, h: 6.5, label: "ミラーボール用バトン" }),
  pinIds: Object.freeze(["mirror-pin-01", "mirror-pin-02"]), pinNo: 98, pinU: Object.freeze([0.03, 0.97]), pinBeamDeg: 8,
  ballColor: "#f2ead6", pinColor: "#fff4dc",
  facets: "mid", surfaces: Object.freeze({ floor: true, back: true, ceil: true, side: true }), rays: true,
});
const fixtureColor = (f) => f.soundRole === "point" ? STAGE_POINT_STYLE.color
  : f.soundRole === "mirror-pin" ? STAGE_MIRROR_STYLE.pinColor : f.kind === "mirrorball" ? STAGE_MIRROR_STYLE.ballColor : COLORS[f.mount.type];

// 音程がある場合はそれを正本にする。表示位置の丸めや同じx値で別の音程を束ねない。
function pointIdentity(point) {
  if (Number.isInteger(point.pitch)) return { key: `midi:${point.pitch}`, x: (point.pitch - 21) / 87 };
  const x = clamp(finite(point.x, 0.5), 0, 1);
  return { key: `position:${x}`, x };
}

/** sample-lightdesign.json mid-f-041〜052 の mount/種別と、確定したLED列。 */
export function createDefaultRig(pointSources = [], { mirrorBall = false } = {}) {
  const fixtures = [];
  for (const v of [0.32, 0.68]) for (const side of ["shimote", "kamite"]) for (const h of [0.55, 2.4]) {
    const no = 41 + fixtures.length, low = h === 0.55;
    fixtures.push({ id: `mid-f-${String(no).padStart(3, "0")}`, no, name: `SS ${no}`,
      mount: { type: "side", side, v, h }, kind: "fixed", beamDeg: low ? STAGE_LIGHT_STYLE.sideLowBeamDeg : STAGE_LIGHT_STYLE.sideHighBeamDeg,
      fixtureType: low ? "led-par" : "profile-zoom", family: low ? "wash" : "profile", role: low ? "SS低段" : "SS高段" });
  }
  for (const [u, v] of [[0.3, 0.0667], [0.7, 0.0667], [0.0417, 0.0889], [0.9583, 0.0889]]) {
    const no = 41 + fixtures.length;
    fixtures.push({ id: `mid-f-${String(no).padStart(3, "0")}`, no, name: `転がし ${no}`,
      mount: { type: "floor", u, v }, kind: "moving", beamDeg: STAGE_LIGHT_STYLE.floorBeamDeg, fixtureType: "moving-wash", family: "moving", role: "転がし" });
  }
  for (let k = 0; k < 20; k++) fixtures.push({ id: `led-bar-${String(k + 1).padStart(2, "0")}`, no: 53 + k, name: `LEDバー ${k + 1}`,
    mount: { type: "truss", trussId: "bar-t-01", u: (k + 0.5) / 20 }, kind: "fixed", fixtureType: "led-bar", family: "led", beamDeg: 40, role: "吊り" });
  const p = STAGE_POINT_STYLE;
  const sources = [...new Map(pointSources.map((point) => {
    const identity = pointIdentity(point); return [identity.key, identity];
  })).values()].sort((a, b) => a.x - b.x || a.key.localeCompare(b.key));
  const count = Math.max(p.count, sources.length), pointFixtureIds = new Map();
  const spotId = (k) => `note-spot-${String(k + 1).padStart(2, "0")}`;
  const trussId = (row) => `bar-note-${String(row + 1).padStart(2, "0")}`;
  sources.forEach((source, i) => {
    // count >= sources.length なので丸めた後も各スロットは必ず別になる。
    const slot = Math.round((sources.length > 1 ? i / (sources.length - 1) : clamp(source.x, 0, 1)) * (count - 1));
    pointFixtureIds.set(source.key, spotId(slot));
  });
  for (let k = 0; k < count; k++) fixtures.push({ id: spotId(k), no: 73 + k, name: `単音スポット ${k + 1}`,
    mount: { type: "truss", trussId: trussId(k % p.rows.length), u: p.uStart + (p.uEnd - p.uStart) * k / (count - 1) },
    pointRow: k % p.rows.length,
    kind: "fixed", fixtureType: "profile-zoom", family: "profile", beamDeg: p.beamDeg, role: "吊り単音", soundRole: "point" });
  const trusses = [{ id: "bar-t-01", v: 0.5, h: 6.5, label: "照明バトン2" },
    ...p.rows.map((row, i) => ({ id: trussId(i), v: row.barV, h: p.barHeight, label: `単音スポット用バトン${i + 1}` }))];
  let mirror = null;
  if (mirrorBall) {
    const m = STAGE_MIRROR_STYLE;
    trusses.push({ ...m.ballTruss });
    fixtures.push({ id: m.ballId, no: m.ballNo, name: "ミラーボール", mount: { type: "truss", trussId: m.ballTruss.id, u: m.ballU },
      kind: "mirrorball", mirrorBall: { diameterM: m.diameterM, ...(m.rpm == null ? {} : { rpm: m.rpm }) }, role: "吊り球", soundRole: "mirror-ball" });
    m.pinIds.forEach((id, i) => fixtures.push({ id, no: m.pinNo + i, name: `ピン ${i + 1}`, mount: { type: "truss", trussId: m.ballTruss.id, u: m.pinU[i] },
      kind: "fixed", fixtureType: "profile-zoom", family: "profile", beamDeg: m.pinBeamDeg, role: "ピン", soundRole: "mirror-pin", pinSlot: i }));
    mirror = { ballId: m.ballId, pinIds: [...m.pinIds] };
  }
  return { trusses, fixtures, pointFixtureIds, mirror };
}

/** 球の中心（γ rig-engine.mirrorBallCentre と同じ式: 取り付け点から吊り代と半径だけ下）。 */
function mirrorBallCentreOf(rig) {
  const ball = rig.mirror && rig.fixtures.find((f) => f.id === rig.mirror.ballId);
  if (!ball) return null;
  const truss = rig.trusses.find((t) => t.id === ball.mount.trussId), R = ball.mirrorBall.diameterM / 2;
  return { u: ball.mount.u, v: truss.v, hM: Math.max(R, truss.h - 0.3 - R) };   // 0.3 = γ MIRROR_BALL.hangM
}

export function createStageDesign(rig = createDefaultRig()) {
  const lights = {};
  const ballAim = mirrorBallCentreOf(rig);
  for (const f of rig.fixtures) {
    const m = f.mount, point = f.soundRole === "point";
    if (f.kind === "mirrorball" || f.soundRole === "mirror-pin") {
      // 球＝level 0・on:true が「回す」（γの契約）。ピン＝球の中心を狙う空中の光＋ light.target。
      lights[f.id] = f.kind === "mirrorball"
        ? { on: true, level: 0, color: fixtureColor(f), surface: "air", path: { kind: "still", a: { u: ballAim.u, v: ballAim.v, hM: Math.max(0, ballAim.hM - 1) } },
          speed: "normal", periodSec: null, offsetSec: 0, levelTo: null, beamDegTo: null, beamDeg: f.beamDeg, beamEdgeSoftness: 2,
          gobo: "none", goboSoft: 6, goboSpin: 0, goboAngle: 0, strobe: null, shutter: null, glare: 1, groupId: null }
        : { on: true, level: 100, color: fixtureColor(f), surface: "air", path: { kind: "still", a: { ...ballAim } }, target: { fixtureId: rig.mirror.ballId },
          speed: "normal", periodSec: null, offsetSec: 0, levelTo: null, beamDegTo: null, beamDeg: f.beamDeg, beamEdgeSoftness: STAGE_POINT_STYLE.softness,
          gobo: "none", goboSoft: 6, goboSpin: 0, goboAngle: 0, strobe: null, shutter: null, glare: 1, groupId: null };
      continue;
    }
    // 転がしは舞台奥から客席側へ。LEDは発光面と近傍のにじみだけで、照射面を持たない。
    const aim = m.type === "floor" ? { u: m.u, v: STAGE_LIGHT_STYLE.floorAimV, hM: STAGE_LIGHT_STYLE.floorAimHeight }
      : m.type === "side" ? { u: m.side === "shimote" ? 0.85 : 0.15, v: m.v, hM: 1.0 }
      : { u: m.u, v: point ? STAGE_POINT_STYLE.rows[f.pointRow].aimV : 0.5, hM: 0 };
    lights[f.id] = { on: true, level: 100, color: fixtureColor(f), surface: m.type === "side" || point ? "floor" : "air", path: { kind: "still", a: aim },
      speed: "normal", periodSec: null, offsetSec: 0, levelTo: null, beamDegTo: null, beamDeg: f.beamDeg,
      beamEdgeSoftness: point ? STAGE_POINT_STYLE.softness : m.type === "floor" ? STAGE_LIGHT_STYLE.floorSoftness : STAGE_LIGHT_STYLE.sideSoftness,
      gobo: "none", goboSoft: 6, goboSpin: 0, goboAngle: 0, strobe: null, shutter: null, glare: 1, groupId: null };
  }
  return { format: "shosai.light-design", stage: { ...STAGE_SIZE }, rig,
    scenes: [{ id: "oto-stage", name: "舞台", cue: { lights, groups: [], environment: { haze: 35 } } }] };
}

/** leds[] は0始まり。純粋関数: cue優先・未来の打点は不使用・重複はmax。 */
export function fixtureLevelsAt(t, expData, rig, { spin01 = 0 } = {}) {
  const levels = new Map(rig.fixtures.map((f) => [f.id, { level: 0, color: fixtureColor(f) }]));
  if (!expData || expData.cues.some((c) => c.type === "silence" && t >= c.t && t <= c.t + c.dur)) return levels;
  const hits = expData.hits;
  let lo = 0, hi = hits.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (hits[mid].t < t - DRUM_WINDOW.hat) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < hits.length; i++) {
    const hit = hits[i]; if (hit.t > t) break;
    const age = t - hit.t, window = DRUM_WINDOW[hit.tag];
    if (!window || age < 0 || age >= window) continue;
    const strength = clamp(hit.level, 0, 1), remaining = 1 - age / window;
    const life = hit.tag === "kick" ? remaining ** 2.6 * strength
      : hit.tag === "snare" ? remaining ** 1.5 * strength : remaining ** 2 * (3 - 2 * remaining) * (0.5 + 0.5 * strength);
    const type = { kick: "floor", snare: "side", hat: "truss" }[hit.tag];
    const ids = hit.tag === "hat" ? new Set((hit.leds || []).filter((k) => Number.isInteger(k) && k >= 0 && k < 20).map((k) => `led-bar-${String(k + 1).padStart(2, "0")}`)) : null;
    for (const f of rig.fixtures) if (f.mount.type === type && (!ids || ids.has(f.id))) {
      const value = levels.get(f.id); value.level = Math.max(value.level, life * 100);
    }
  }
  // アタックの時刻だけで短く点滅。音価が長い音にも光の保持は足さず、連打はそれぞれ再発火する。
  const points = expData.points || [];
  lo = 0; hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].t < t - STAGE_POINT_STYLE.windowSec) lo = mid + 1; else hi = mid; }
  for (let i = lo; i < points.length; i++) {
    const point = points[i]; if (point.t > t) break;
    const age = t - point.t;
    if (age < 0 || age >= STAGE_POINT_STYLE.windowSec) continue;
    const value = levels.get(rig.pointFixtureIds.get(pointIdentity(point).key));
    if (!value) continue;
    const life = (1 - age / STAGE_POINT_STYLE.windowSec) ** STAGE_POINT_STYLE.decayPower;
    value.level = Math.max(value.level, life * clamp(finite(point.level, 0), 0, 1) * 100);
  }
  // ミラーボールのピン: 回っている間の常時の明るさ＋拍（キック・スネア、無ければ拍）の閃光。
  if (rig.mirror) pinLevelsAt(t, expData, spin01).forEach((level, i) => { levels.get(rig.mirror.pinIds[i]).level = level; });
  return levels;
}

function activateProjection(view, width, height) {
  camera = view; state = view; canvasWidth = width; canvasHeight = height;
  focal = focalFor(width, LENSES.find((lens) => lens.id === "wide").fovDeg) * clamp(finite(view.lensScale, 1), .5, 3);
  setBasis();
}
/** DOM不要の投影契約検査用。γ世界{x:左右,y:奥行き,z:高さ}を受ける。 */
export function projectStagePoint(point, { viewpoint = "house-center", width = 1440, height = 760 } = {}) {
  activateProjection(VIEWPOINTS[viewpoint] || VIEWPOINTS["house-center"], width, height);
  return cueLightProjector()(point);
}

const floorCorners = () => [toWorld(0, 0, W, D), toWorld(1, 0, W, D), toWorld(1, 1, W, D), toWorld(0, 1, W, D)];
function drawBox(ctx, p, length, thickness, fill, stroke) {
  const x = length / 2, y = thickness / 2, z = thickness / 2;
  const points = [[-x,-y,-z],[x,-y,-z],[x,y,-z],[-x,y,-z],[-x,-y,z],[x,-y,z],[x,y,z],[-x,y,z]]
    .map(([dx,dy,dz]) => ({ x: p.x + dx, y: p.y + dy, z: p.z + dz }));
  const faces = [[0,1,2,3],[4,7,6,5],[0,4,5,1],[3,2,6,7],[0,3,7,4],[1,5,6,2]]
    .map((ids) => ids.map((i) => points[i]));
  faces.sort((a,b) => b.reduce((s,p) => s + toCamera(p).z, 0) - a.reduce((s,p) => s + toCamera(p).z, 0));
  for (const face of faces) fillPoly(ctx, face, fill, stroke, 1);
}

/** LEDの発光面と、その近傍の拡散光。画素を蓄積せず、その時刻の光量だけで描く。 */
function drawLedBar(ctx, p, color, level) {
  const s = STAGE_LED_STYLE, life = clamp(level, 0, 1);
  drawBox(ctx, p, s.length, s.thickness, s.body, s.edge);
  if (!(life > 0)) return;
  const ends = clipPolyNear([-1, 1].map((sign) => toCamera({ ...p, x: p.x + sign * s.length * s.emitterRatio / 2 })));
  if (ends.length !== 2) return;
  const [a, b] = ends.map(toScreen), length = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(length > 0)) return;
  const px = focal / Math.max(NEAR, (ends[0].z + ends[1].z) / 2);
  const core = clamp(s.coreWidth * px, 0.9, 3);
  const halo = clamp(s.haloRadius * px, 2.5, 12) * (0.65 + 0.35 * Math.sqrt(life));
  const rgba = (hex, opacity) => {
    const rgb = parseInt(hex.slice(1), 16);
    return `rgba(${rgb >> 16 & 255},${rgb >> 8 & 255},${rgb & 255},${opacity})`;
  };
  ctx.save();
  ctx.translate((a.x + b.x) / 2, (a.y + b.y) / 2);
  ctx.rotate(Math.atan2(b.y - a.y, b.x - a.x));
  ctx.globalCompositeOperation = "screen";
  const glow = (rx, ry, alpha) => {
    ctx.save(); ctx.scale(rx, ry);
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    for (const [at, weight] of [[0, 1], [0.3, 0.5], [0.65, 0.125], [1, 0]]) gradient.addColorStop(at, rgba(color, alpha * life * weight));
    ctx.fillStyle = gradient; ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  };
  glow(length / 2 + halo, halo, 0.36);
  glow(length / 2 + halo * 0.2, core * 0.6 + halo * 0.22, 0.65);
  ctx.strokeStyle = rgba(s.core, 0.95 * life);
  ctx.lineWidth = core; ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(-length / 2, 0); ctx.lineTo(length / 2, 0); ctx.stroke();
  ctx.restore();
}

/** 空中の光は実際の狙い先で切る。床の斜入射楕円の中心とは別の幾何。
 * γの塗りを使い続け、レンズ半径＋距離×tan(照射角/2)の幅と光軸に直交する面を渡す。 */
function beamOf(fixture, light, source, dims, engine, sourceRadiusM = 0) {
  const aim = light.path.a;
  const from = { ...source };
  const to = { x: (aim.u - 0.5) * dims.W, y: aim.v * dims.D, z: aim.hM };
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const length = Math.hypot(delta.x, delta.y, delta.z);
  if (!(length > 0)) return null;
  const axis = { x: delta.x / length, y: delta.y / length, z: delta.z / length };
  const horizontal = Math.hypot(axis.x, axis.y);
  const across = horizontal > 0 ? { x: -axis.y / horizontal, y: axis.x / horizontal, z: 0 } : { x: 1, y: 0, z: 0 };
  const radiusM = sourceRadiusM + engine.spotRadiusM(from, to, engine.beamDegOf(fixture, light));
  const eb = { x: across.x * radiusM, y: across.y * radiusM, z: 0 };
  const ea = { x: -axis.z * across.y * radiusM, y: axis.z * across.x * radiusM, z: (axis.x * across.y - axis.y * across.x) * radiusM };
  return { from, to, c: to, ea, eb, radiusM, sourceRadiusM, surface: "air", softness: light.beamEdgeSoftness };
}

/** γの光の筋は1枚の断面。光軸と視線に直交する幅を渡し、横から見ても細線にしない。
 * 視点は{x:左右,y:高さ,z:舞台中央基準の奥行き}、光はγの座標系。元モデルは変えない。 */
export function beamFacingView(beam, view) {
  const a = { x: beam.to.x - beam.from.x, y: beam.to.y - beam.from.y, z: beam.to.z - beam.from.z };
  const v = { x: view.x - beam.from.x, y: view.z + D / 2 - beam.from.y, z: view.y - beam.from.z };
  const b = { x: a.y * v.z - a.z * v.y, y: a.z * v.x - a.x * v.z, z: a.x * v.y - a.y * v.x };
  const size = Math.hypot(b.x, b.y, b.z);
  if (size < 1e-8) return beam;
  const scale = beam.radiusM / size;
  return { ...beam, eb: { x: b.x * scale, y: b.y * scale, z: b.z * scale } };
}

/** レンズ面から始まる円錐台の断面。仮想頂点はγの塗り専用で、光源の正本は動かさない。 */
export function beamApertureGeometry(beam) {
  const r = beam.sourceRadiusM;
  if (!(r > 0 && beam.radiusM > r)) return null;
  const soft = 1.26; // vendor/gamma/stage-light-render.js の BEAM_SOFT（無改変）
  const radius = r + (beam.radiusM - r) * soft;
  const width = Object.fromEntries(["x", "y", "z"].map((k) => [k, beam.eb[k] / beam.radiusM]));
  const edge = (center, distance) => Object.fromEntries(["x", "y", "z"].map((k) => [k, center[k] + width[k] * distance]));
  const near = [edge(beam.from, r), edge(beam.from, -r)];
  const far = [edge(beam.to, radius), edge(beam.to, -radius)];
  const from = Object.fromEntries(["x", "y", "z"].map((k) => [k, beam.from[k] - (beam.to[k] - beam.from[k]) * r / (radius - r)]));
  const eb = Object.fromEntries(["x", "y", "z"].map((k) => [k, width[k] * radius / soft]));
  return { near, far, paint: { ...beam, from, eb, apertureFrom: beam.from } };
}

/** γの無改変模型を仕込みへ置く。床置きだけx軸回り180°で土台を上向きにする。 */
export function fixtureBodyGeometry(fixture, light, marker, dims, body) {
  if (fixture.fixtureType === "led-bar" || fixture.kind === "mirrorball") return null;
  const source = { x: (marker.u - 0.5) * dims.W, y: marker.v * dims.D, z: marker.h };
  const a = light.path.a, aim = { x: (a.u - 0.5) * dims.W, y: a.v * dims.D, z: a.hM };
  const make = fixture.kind === "moving" ? body.movingHead : body.parCan;
  if (fixture.mount.type !== "floor") return make(source, aim, { scale: 1 });
  const geom = make({ x: 0, y: 0, z: 0 }, { x: aim.x - source.x, y: source.y - aim.y, z: -aim.z }, { scale: 1 });
  const rotate = (value) => {
    if (Array.isArray(value)) return value.map(rotate);
    if (!value || typeof value !== "object") return value;
    if ([value.x, value.y, value.z].every(Number.isFinite)) return { x: source.x + value.x, y: source.y - value.y, z: -value.z };
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rotate(v)]));
  };
  const standing = rotate(geom);
  standing.dir = { x: geom.dir.x, y: -geom.dir.y, z: -geom.dir.z };
  standing.pan = Math.atan2(standing.dir.x, standing.dir.y);
  standing.tilt = Math.acos(clamp(-standing.dir.z, -1, 1));
  return standing;
}
const bodyVertices = (g) => [...g.base.top, ...g.base.bottom, ...g.yoke.bar, ...g.yoke.arms.flat(), ...g.head.front, ...g.head.back, ...g.head.rails.flat()];

/** γの複製で照明モデルを組み、音アタリ側で模型のレンズ位置と照射を接続する（DOM不要）。 */
export function buildStageModel(design, rig, { overlay, plan, engine, body }) {
  const model = overlay.build(design, design.scenes[0].id, plan);
  if (!model) return null;
  const floorZ = (engine && engine.FLOOR_FIXTURE_Z) ?? 0.3;
  const lights = design.scenes[0].cue.lights, fixtureById = new Map(rig.fixtures.map((f) => [f.id, f]));
  for (const f of model.fixtures) {
    const fixture = fixtureById.get(f.id);
    if (!fixture) continue;
    if (fixture.mount.type === "floor") f.h = floorZ;
    const led = fixture.fixtureType === "led-bar" || fixture.kind === "mirrorball";   // 自発光・球は模型も光の筋も持たない
    f.body = fixtureBodyGeometry(fixture, lights[f.id], f, model.dims, body);
    f.bodyVertices = f.body ? bodyVertices(f.body) : [];
    f.beam = led ? null : beamOf(fixture, lights[f.id], f.body.lens, model.dims, engine,
      fixture.kind === "moving" ? f.body.size.headR : 0);
    if (led || fixture.mount.type === "floor" || fixture.soundRole === "mirror-pin") f.pool = null;   // ピンは空中の筋だけ（床の光だまりは作らない）
    else {
      // γ v0.2.85 以降の poolOf は FIXTURE_BODY の同じ模型でレンズ先端を自分で求める。吊り点を渡し、レンズを二重に足さない。
      const pool = overlay.poolOf(fixture, lights[f.id], f, model.dims, engine);
      f.pool = pool && { ...pool, from: f.body.lens };   // 光源は beam と同じ模型レンズ先端（吊り点の狙い先ずれで 1〜2cm 動くのを揃える）
    }
  }
  return model;
}

export class Stage3dRenderer {
  // mirrorBall: 舞台にミラーボール＋ピン2灯を置くか。既定は操作できる本体（interactive）だけオン。外側が描く歌唱試験（interactive:false）には足さない。
  constructor(canvas, { interactive = true, mirrorBall = interactive } = {}) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.data = null;
    this.mirrorBallOn = Boolean(mirrorBall); this.mirrorTrack = null; this.mirrorInfo = null;
    this.render = window.SHOSAI_LIGHT_RENDER;
    this.body = window.FIXTURE_BODY;
    const overlay = window.SHOSAI_STAGE_LIGHT_CUE_OVERLAY;
    const plan = window.SHOSAI_STAGE_LIGHTING_PLAN_OVERLAY;
    if (!window.RIG_ENGINE || !this.render || !overlay || !plan || !this.body) throw new Error("舞台の描画部品を読み込めません。ページを再読み込みしてください");
    this.modelParts = { overlay, plan, engine: window.RIG_ENGINE, body: this.body };
    this.setRig(createDefaultRig([], { mirrorBall: this.mirrorBallOn }));
    this.setViewpoint("house-center");
    if (!interactive) return; // 外側が回転/ピンチを扱う歌唱試験ではイベントを二重登録しない。
    let drag = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      // γ L4015は画像を掴む向き（-=）。今回の指定「右ドラッグで右を向く」は+=。
      this.view.yaw += (e.clientX - drag.x) * .22;
      this.view.pitch = clamp(this.view.pitch + (e.clientY - drag.y) * .18, -60, 30);
      drag.x = e.clientX; drag.y = e.clientY;
    });
    const endDrag = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    canvas.addEventListener("pointerup", endDrag); canvas.addEventListener("pointercancel", endDrag); canvas.addEventListener("lostpointercapture", endDrag);
  }
  setRig(rig) {
    const sameLayout = this.rig?.fixtures.length === rig.fixtures.length;
    this.rig = rig;
    if (sameLayout) return;
    // 幾何の作り直しは曲の必要台数が変わった時だけ。再生・シーク・ルールOFFでは不要。
    this.design = createStageDesign(rig);
    this.model = buildStageModel(this.design, rig, this.modelParts);
    this.pools = new Map(this.model.fixtures.filter((f) => f.pool).map((f) => [f.id, f.pool]));
    this.beams = new Map(this.model.fixtures.filter((f) => f.beam).map((f) => [f.id, f.beam]));
    // ミラーボール: 球の位置・半径は γ の読取モデル（overlay.build の mirrorBall 枠）から。ピンの光源は模型のレンズ先端。
    const ball = this.model.fixtures.find((f) => f.mirrorBall);
    const pins = (rig.mirror?.pinIds || []).map((id) => this.model.fixtures.find((f) => f.id === id));
    this.mirrorModel = ball && pins.every((p) => p && p.body) ? { ball: ball.mirrorBall, pins: pins.map((p) => ({ id: p.id, from: p.body.lens, beamDeg: this.design.scenes[0].cue.lights[p.id].beamDeg })) } : null;
    this.rebuildMirrorTrack();
  }
  /** 持続音の区間 spans（秒）から回転の前計算を作り直す。rpm は球の指定（無ければγの既定）。 */
  rebuildMirrorTrack() {
    const spans = this.mirrorSpans || [];
    const ball = this.rig.mirror && this.rig.fixtures.find((f) => f.id === this.rig.mirror.ballId);
    const rpm = ball ? this.modelParts.engine.mirrorBallOf(ball).rpm : 0;
    this.mirrorTrack = this.mirrorModel ? buildSpinTrack(spans, { durationSec: this.mirrorDuration || 0, rpm }) : null;
  }
  /** expData＝collectExperienceData の戻り値。mirror＝{ spans:[{start,end}], durationSec }（持続音の区間。無ければ球は止まったまま）。 */
  setData(expData, mirror = {}) {
    this.data = expData;
    this.mirrorSpans = mirror.spans || []; this.mirrorDuration = mirror.durationSec || 0;
    this.setRig(createDefaultRig([...(expData?.pointSources || []), ...(expData?.points || [])], { mirrorBall: this.mirrorBallOn }));
    this.rebuildMirrorTrack();
  }
  setMirrorBall(on) {
    this.mirrorBallOn = Boolean(on);
    this.setRig(createDefaultRig([...(this.data?.pointSources || []), ...(this.data?.points || [])], { mirrorBall: this.mirrorBallOn }));
  }
  reset() { this.data = null; }
  setViewpoint(id) { if (VIEWPOINTS[id]) { this.viewpoint = id; this.view = { ...VIEWPOINTS[id] }; } }
  setCamera(view) {
    if (![view.x, view.y, view.z, view.yaw, view.pitch].every(Number.isFinite)) return;
    this.viewpoint = "custom"; this.view = { ...view };
  }
  resize() {
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.round(rect.width)); this.h = Math.max(1, Math.round(rect.height));
    const width = Math.round(this.w * dpr), height = Math.round(this.h * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    activateProjection(this.view, this.w, this.h);
  }
  drawShell() {
    const ctx = this.ctx, floor = floorCorners();
    ctx.fillStyle = "#080C13"; ctx.fillRect(0, 0, this.w, this.h);
    fillPoly(ctx, [floor[0], floor[1], toWorld(1, 0, W, D, H), toWorld(0, 0, W, D, H)], "#101824");
    fillPoly(ctx, floor, "#1A202B", "#2C2C30", 1);
    for (const bar of this.rig.trusses) line3(ctx, toWorld(0, bar.v, W, D, bar.h), toWorld(1, bar.v, W, D, bar.h), "#2C2C30", 2);
  }
  drawFixtures(levels) {
    const P = cueLightProjector();
    const fixtures = this.model.fixtures.map((marker) => ({ marker, point: toWorld(marker.u, marker.v, W, D, marker.h) }))
      .sort((a,b) => toCamera(b.point).z - toCamera(a.point).z);
    for (const { marker, point } of fixtures) {
      const value = levels.get(marker.id), led = marker.id.startsWith("led-bar-");
      const alpha = value.level / 100;
      if (led) {
        drawLedBar(this.ctx, { ...point, y: Math.max(0.03, point.y) }, value.color, alpha);
      } else if (marker.body && marker.bodyVertices.every((p) => P(p))) {
        const pivot = marker.body.pivot;
        const depth = toCamera({ x: pivot.x, y: pivot.z, z: pivot.y - D / 2 }).z;
        this.body.draw(this.ctx, P, marker.body, { color: value.color, lit: alpha,
          beamDeg: this.design.scenes[0].cue.lights[marker.id].beamDeg,
          glow: marker.beam.sourceRadiusM > 0 ? false : undefined,
          px: focal / depth, appearance: "white-line", ink: FIXTURE_OUTLINE_COLOR });
      }
    }
  }
  paintBeams(beams, P, opts) {
    this.render.paintBeams(this.ctx, beams.filter((b) => !b.sourceRadiusM), P, opts);
    for (const beam of beams.filter((b) => b.sourceRadiusM > 0)) {
      const shape = beamApertureGeometry(beam);
      const [a, b] = shape.near.map(P), end = P(beam.to);
      if (!a || !b || !end) continue;
      const length = Math.hypot(b.X - a.X, b.Y - a.Y);
      if (!(length > 1e-8)) continue;
      const u = { X: (b.X - a.X) / length, Y: (b.Y - a.Y) / length };
      const side = Math.sign((end.X - a.X) * -u.Y + (end.Y - a.Y) * u.X);
      if (!side) continue;
      const reach = Math.hypot(this.w, this.h) + Math.hypot(a.X, a.Y);
      const near = [{ X: a.X - u.X * reach, Y: a.Y - u.Y * reach },
        { X: b.X + u.X * reach, Y: b.Y + u.Y * reach }];
      const far = near.map((p) => ({ X: p.X - u.Y * reach * 2 * side, Y: p.Y + u.X * reach * 2 * side }));
      // γの帯は終端の投影幅を対称化する。側縁まで実3Dの四辺形で切ると硬い線になるため、根元だけ切る。
      const corners = [near[0], near[1], far[1], far[0]];
      const ctx = this.ctx;
      ctx.save(); ctx.beginPath();
      ctx.moveTo(corners[0].X, corners[0].Y);
      for (const p of corners.slice(1)) ctx.lineTo(p.X, p.Y);
      ctx.closePath(); ctx.clip();
      this.render.paintBeam(ctx, shape.paint, P, opts);
      ctx.restore();
    }
  }
  /** 球の体と反射の粒。回転は rpm 0＋角度（持続音の積分）で渡すので、時刻だけで決まりシークで同じ絵になる。 */
  paintMirrorBall(ctx, P, levels, spin) {
    const { ball, pins } = this.mirrorModel, S = STAGE_MIRROR_STYLE, R = this.render;
    const record = { ...ball, rpm: 0, phaseDeg: spin.phaseDeg,
      sources: pins.map((pin) => ({ from: pin.from, color: S.pinColor, level: levels.get(pin.id).level, beamDeg: pin.beamDeg })).filter((src) => src.level > 0) };
    R.paintMirrorBalls(ctx, [record], P, { tMs: 0, dims: { W, D, H }, facets: R.MIRROR_BALL_FACETS[S.facets], surfaces: S.surfaces,
      rays: S.rays, topDown: false, eye: { x: this.view.x, y: this.view.z + D / 2, z: this.view.y } });
  }
  // vocal は解析/時間補間済みの {open, stretch, round, energy} (0〜1)。未指定は非表示。
  // 煙にも呼び出し元の t を使う。レンダラー内で音源を解析・再生しない。
  frame(t, { playing = false, vocal = null, fixtureLighting = true } = {}) {
    this.resize();
    const spin = this.mirrorTrack ? spinAt(this.mirrorTrack, t) : { env: 0, phaseDeg: 0 };
    const ctx = this.ctx, levels = fixtureLevelsAt(t, fixtureLighting ? this.data : null, this.rig, { spin01: spin.env });
    const pools = [...this.pools].map(([id, pool]) => ({ ...pool, ...levels.get(id) })).filter((p) => p.level > 0);
    const beams = [...this.beams].filter(([id]) => levels.get(id).level > 0)
      .map(([id, beam]) => ({ ...beamFacingView(beam, this.view), ...levels.get(id) }));
    const P = cueLightProjector(), opts = { topDown: false, tMs: t * 1000, haze: this.render.hazeAmount(35) };
    this.drawShell();
    this.render.paintPools(ctx, pools, P, opts);
    // 歌う口が出ている間は作業灯を暗くする（TOKEN_SHEET §23）。光の筋は v0.7.0 以降どおり1回だけ描く。
    this.render.paintWorkLight(ctx, pools, P, { ...opts, dim: vocal ? .55 : 1, floorClip: clipCueLightSurfaces });
    this.paintBeams(beams, P, opts);
    if (fixtureLighting && this.mirrorModel) this.paintMirrorBall(ctx, P, levels, spin);
    drawVocalLaser(ctx, vocal, t, P);
    this.drawFixtures(levels);   // γと同じく光の後に筐体を重ね、消灯中も形と向きを残す。
    // playingは共通描画器の契約として受け取る。時刻以外で光を変えない。
  }
}
