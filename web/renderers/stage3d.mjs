// 舞台表示の投影・照明アダプタ。数値の正本: design/TOKEN_SHEET.md §13・§16〜18。
// γの幾何ブロックは _delegation/gamma-src-2026-10-01/stage-first-person.js から無改変抽出。
import { DRUM_WINDOW } from "./experience.mjs?v=20261002b";

const W = 12, D = 9, H = 8;
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
  count: 8, uStart: 0.1, uEnd: 0.9, barV: 0.32, barHeight: 6.5, aimV: 0.55,
  beamDeg: 18, softness: 2, color: "#b7f9ec", windowSec: 0.6, decayPower: 1.8,
});
const fixtureColor = (f) => f.soundRole === "point" ? STAGE_POINT_STYLE.color : COLORS[f.mount.type];

/** sample-lightdesign.json mid-f-041〜052 の mount/種別と、確定したLED列。 */
export function createDefaultRig() {
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
  for (let k = 0; k < p.count; k++) fixtures.push({ id: `note-spot-${String(k + 1).padStart(2, "0")}`, no: 73 + k, name: `単音スポット ${k + 1}`,
    mount: { type: "truss", trussId: "bar-note-01", u: p.uStart + (p.uEnd - p.uStart) * k / (p.count - 1) },
    kind: "fixed", fixtureType: "profile-zoom", family: "profile", beamDeg: p.beamDeg, role: "吊り単音", soundRole: "point" });
  return { trusses: [{ id: "bar-t-01", v: 0.5, h: 6.5, label: "照明バトン2" },
    { id: "bar-note-01", v: p.barV, h: p.barHeight, label: "単音スポット用バトン" }], fixtures };
}

export function createStageDesign(rig = createDefaultRig()) {
  const lights = {};
  for (const f of rig.fixtures) {
    const m = f.mount, point = f.soundRole === "point";
    // 転がしは舞台奥から客席側へ。LEDは箱の自発光だけで、照射面を持たない。
    const aim = m.type === "floor" ? { u: m.u, v: STAGE_LIGHT_STYLE.floorAimV, hM: STAGE_LIGHT_STYLE.floorAimHeight }
      : m.type === "side" ? { u: m.side === "shimote" ? 0.85 : 0.15, v: m.v, hM: 1.0 }
      : { u: m.u, v: point ? STAGE_POINT_STYLE.aimV : 0.5, hM: 0 };
    lights[f.id] = { on: true, level: 100, color: fixtureColor(f), surface: m.type === "side" || point ? "floor" : "air", path: { kind: "still", a: aim },
      speed: "normal", periodSec: null, offsetSec: 0, levelTo: null, beamDegTo: null, beamDeg: f.beamDeg,
      beamEdgeSoftness: point ? STAGE_POINT_STYLE.softness : m.type === "floor" ? STAGE_LIGHT_STYLE.floorSoftness : STAGE_LIGHT_STYLE.sideSoftness,
      gobo: "none", goboSoft: 6, goboSpin: 0, goboAngle: 0, strobe: null, shutter: null, glare: 1, groupId: null };
  }
  return { format: "shosai.light-design", stage: { ...STAGE_SIZE }, rig,
    scenes: [{ id: "oto-stage", name: "舞台", cue: { lights, groups: [], environment: { haze: 35 } } }] };
}

/** leds[] は0始まり。純粋関数: cue優先・未来の打点は不使用・重複はmax。 */
export function fixtureLevelsAt(t, expData, rig) {
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
      : hit.tag === "snare" ? remaining ** 1.5 * strength : remaining * (0.5 + 0.5 * strength);
    const type = { kick: "floor", snare: "side", hat: "truss" }[hit.tag];
    const ids = hit.tag === "hat" ? new Set((hit.leds || []).filter((k) => Number.isInteger(k) && k >= 0 && k < 20).map((k) => `led-bar-${String(k + 1).padStart(2, "0")}`)) : null;
    for (const f of rig.fixtures) if (f.mount.type === type && (!ids || ids.has(f.id))) {
      const value = levels.get(f.id); value.level = Math.max(value.level, life * 100);
    }
  }
  // アタックの時刻だけで短く点滅。音価が長い音にも光の保持は足さず、連打はそれぞれ再発火する。
  const spots = rig.fixtures.filter((f) => f.soundRole === "point"), points = expData.points || [];
  lo = 0; hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (points[mid].t < t - STAGE_POINT_STYLE.windowSec) lo = mid + 1; else hi = mid; }
  for (let i = lo; spots.length && i < points.length; i++) {
    const point = points[i]; if (point.t > t) break;
    const age = t - point.t;
    if (age < 0 || age >= STAGE_POINT_STYLE.windowSec) continue;
    const slot = Math.min(spots.length - 1, Math.floor(clamp(finite(point.x, 0.5), 0, 1) * spots.length));
    const life = (1 - age / STAGE_POINT_STYLE.windowSec) ** STAGE_POINT_STYLE.decayPower;
    const value = levels.get(spots[slot].id);
    value.level = Math.max(value.level, life * clamp(finite(point.level, 0), 0, 1) * 100);
  }
  return levels;
}

function activateProjection(view, width, height) {
  camera = view; state = view; canvasWidth = width; canvasHeight = height;
  focal = focalFor(width, LENSES.find((lens) => lens.id === "wide").fovDeg);
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

/** 空中の光は実際の狙い先で切る。床の斜入射楕円の中心とは別の幾何。
 * γのpaintBeamsを使い続け、距離×tan(照射角/2)の幅と光軸に直交する面だけここで渡す。 */
function beamOf(fixture, light, source, dims, engine) {
  const aim = light.path.a;
  const from = { ...source };
  const to = { x: (aim.u - 0.5) * dims.W, y: aim.v * dims.D, z: aim.hM };
  const delta = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
  const length = Math.hypot(delta.x, delta.y, delta.z);
  if (!(length > 0)) return null;
  const axis = { x: delta.x / length, y: delta.y / length, z: delta.z / length };
  const horizontal = Math.hypot(axis.x, axis.y);
  const across = horizontal > 0 ? { x: -axis.y / horizontal, y: axis.x / horizontal, z: 0 } : { x: 1, y: 0, z: 0 };
  const radiusM = engine.spotRadiusM(from, to, engine.beamDegOf(fixture, light));
  const eb = { x: across.x * radiusM, y: across.y * radiusM, z: 0 };
  const ea = { x: -axis.z * across.y * radiusM, y: axis.z * across.x * radiusM, z: (axis.x * across.y - axis.y * across.x) * radiusM };
  return { from, to, c: to, ea, eb, radiusM, surface: "air", softness: light.beamEdgeSoftness };
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

/** γの無改変模型を仕込みへ置く。床置きだけx軸回り180°で土台を上向きにする。 */
export function fixtureBodyGeometry(fixture, light, marker, dims, body) {
  if (fixture.fixtureType === "led-bar") return null;
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
    const led = fixture.fixtureType === "led-bar";
    f.body = fixtureBodyGeometry(fixture, lights[f.id], f, model.dims, body);
    f.bodyVertices = f.body ? bodyVertices(f.body) : [];
    f.beam = led ? null : beamOf(fixture, lights[f.id], f.body.lens, model.dims, engine);
    if (led || fixture.mount.type === "floor") f.pool = null;
    else {
      const lens = f.body.lens;
      f.pool = overlay.poolOf(fixture, lights[f.id], { ...f, u: lens.x / model.dims.W + 0.5, v: lens.y / model.dims.D, h: lens.z }, model.dims, engine);
    }
  }
  return model;
}

export class Stage3dRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.data = null;
    this.rig = createDefaultRig(); this.design = createStageDesign(this.rig);
    this.render = window.SHOSAI_LIGHT_RENDER;
    this.body = window.FIXTURE_BODY;
    const overlay = window.SHOSAI_STAGE_LIGHT_CUE_OVERLAY;
    const plan = window.SHOSAI_STAGE_LIGHTING_PLAN_OVERLAY;
    if (!window.RIG_ENGINE || !this.render || !overlay || !plan || !this.body) throw new Error("舞台の描画部品を読み込めません。ページを再読み込みしてください");
    // 幾何はこの1回だけ。setData/視点/時刻の変更ではbuildを呼び直さない。
    this.model = buildStageModel(this.design, this.rig, { overlay, plan, engine: window.RIG_ENGINE, body: this.body });
    this.pools = new Map(this.model.fixtures.filter((f) => f.pool).map((f) => [f.id, f.pool]));
    this.beams = new Map(this.model.fixtures.filter((f) => f.beam).map((f) => [f.id, f.beam]));
    this.setViewpoint("house-center");
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
  setData(expData) { this.data = expData; }
  reset() { this.data = null; }
  setViewpoint(id) { if (VIEWPOINTS[id]) { this.viewpoint = id; this.view = { ...VIEWPOINTS[id] }; } }
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
        const fill = alpha > 0 ? colorAtLevel(value.color, alpha) : "#080C13";
        drawBox(this.ctx, { ...point, y: Math.max(0.03, point.y) }, 0.5, 0.06, fill, alpha > 0 ? fill : "#2C2C30");
      } else if (marker.body && marker.bodyVertices.every((p) => P(p))) {
        const pivot = marker.body.pivot;
        const depth = toCamera({ x: pivot.x, y: pivot.z, z: pivot.y - D / 2 }).z;
        this.body.draw(this.ctx, P, marker.body, { color: value.color, lit: alpha,
          beamDeg: this.design.scenes[0].cue.lights[marker.id].beamDeg,
          px: focal / depth, appearance: "white-line" });
      }
    }
  }
  frame(t, { playing = false } = {}) {
    this.resize();
    const ctx = this.ctx, levels = fixtureLevelsAt(t, this.data, this.rig);
    const pools = [...this.pools].map(([id, pool]) => ({ ...pool, ...levels.get(id) })).filter((p) => p.level > 0);
    const beams = [...this.beams].filter(([id]) => levels.get(id).level > 0)
      .map(([id, beam]) => ({ ...beamFacingView(beam, this.view), ...levels.get(id) }));
    const P = cueLightProjector(), opts = { topDown: false, tMs: t * 1000, haze: this.render.hazeAmount(35) };
    this.drawShell();
    this.render.paintPools(ctx, pools, P, opts);
    this.render.paintBeams(ctx, beams, P, opts);
    this.render.paintWorkLight(ctx, pools, P, { ...opts, floorClip: clipCueLightSurfaces });
    this.render.paintBeams(ctx, beams, P, opts);
    this.drawFixtures(levels);   // γと同じく光の後に筐体を重ね、消灯中も形と向きを残す。
    // playingは共通描画器の契約として受け取る。時刻以外で光を変えない。
  }
}
function colorAtLevel(hex, level) {
  const value = parseInt(hex.slice(1), 16);
  return `rgb(${[value >> 16 & 255, value >> 8 & 255, value & 255].map((v) => Math.round(v * level)).join(",")})`;
}
