// 舞台表示の投影・照明アダプタ。数値の正本: design/TOKEN_SHEET.md §13。
// γの幾何ブロックは _delegation/gamma-src-2026-10-01/stage-first-person.js から無改変抽出。
import { DRUM_WINDOW } from "./experience.mjs";

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
// （γは床だけ。転がしの光だまりが奥壁（surface "back"）にあるため。式は同じ、面を2つ重ねるだけ）
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

/** sample-lightdesign.json mid-f-041〜052 の mount/種別と、確定したLED列。 */
export function createDefaultRig() {
  const fixtures = [];
  for (const v of [0.32, 0.68]) for (const side of ["shimote", "kamite"]) for (const h of [0.55, 2.4]) {
    const no = 41 + fixtures.length, low = h === 0.55;
    fixtures.push({ id: `mid-f-${String(no).padStart(3, "0")}`, no, name: `SS ${no}`,
      mount: { type: "side", side, v, h }, kind: "fixed", beamDeg: low ? 10 : 28,
      fixtureType: low ? "led-par" : "profile-zoom", family: low ? "wash" : "profile", role: low ? "SS低段" : "SS高段" });
  }
  for (const [u, v] of [[0.3, 0.0667], [0.7, 0.0667], [0.0417, 0.0889], [0.9583, 0.0889]]) {
    const no = 41 + fixtures.length;
    fixtures.push({ id: `mid-f-${String(no).padStart(3, "0")}`, no, name: `転がし ${no}`,
      mount: { type: "floor", u, v }, kind: "moving", beamDeg: 36, fixtureType: "moving-wash", family: "moving", role: "転がし" });
  }
  for (let k = 0; k < 20; k++) fixtures.push({ id: `led-bar-${String(k + 1).padStart(2, "0")}`, no: 53 + k, name: `LEDバー ${k + 1}`,
    mount: { type: "truss", trussId: "bar-t-01", u: (k + 0.5) / 20 }, kind: "fixed", fixtureType: "led-bar", family: "led", beamDeg: 40, role: "吊り" });
  return { trusses: [{ id: "bar-t-01", v: 0.5, h: 6.5, label: "照明バトン2" }], fixtures };
}

export function createStageDesign(rig = createDefaultRig()) {
  const lights = {};
  for (const f of rig.fixtures) {
    const m = f.mount;
    /* 転がし: 床置きから床を狙うと光が寝て薄い（2026-10-01 実測: キック時の床ROI 15.4 vs 無音 14.3）。
       舞台の定番どおり奥の壁を下から照らす（surface "back"・高さ3m）＝キックで奥壁が白青く立ち上がる。 */
    const aim = m.type === "floor" ? { u: m.u, v: 0, hM: 3.0 }
      : m.type === "side" ? { u: m.side === "shimote" ? 0.85 : 0.15, v: m.v, hM: 1.0 }
      : { u: m.u, v: 0.5, hM: 0 };
    lights[f.id] = { on: true, level: 100, color: COLORS[m.type], surface: m.type === "floor" ? "back" : "floor", path: { kind: "still", a: aim },
      speed: "normal", periodSec: null, offsetSec: 0, levelTo: null, beamDegTo: null, beamDeg: f.beamDeg,
      gobo: "none", goboSoft: 6, goboSpin: 0, goboAngle: 0, strobe: null, shutter: null, glare: 1, groupId: null };
  }
  return { format: "shosai.light-design", stage: { ...STAGE_SIZE }, rig,
    scenes: [{ id: "oto-stage", name: "舞台", cue: { lights, groups: [], environment: { haze: 35 } } }] };
}

/** leds[] は0始まり。純粋関数: cue優先・未来の打点は不使用・重複はmax。 */
export function fixtureLevelsAt(t, expData, rig) {
  const levels = new Map(rig.fixtures.map((f) => [f.id, { level: 0, color: COLORS[f.mount.type] }]));
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

/** γの複製で照明モデルを組む（DOM不要・テスト対象）。
 *  転がし（床置き）: plan-overlay は marker.h=0 に置き、床狙いと平行になるので rig-engine.spotEllipse が null を返す。
 *  γ本体の fixtureWorld（rig-engine.js L238〜）は床置きの光源高さを FLOOR_FIXTURE_Z=0.3m にしているので、
 *  舞台側だけ同じ高さで pool を作り直す（vendor は変えない。Codex 指摘 2026-10-01）。 */
export function buildStageModel(design, rig, { overlay, plan, engine }) {
  const model = overlay.build(design, design.scenes[0].id, plan);
  if (!model) return null;
  const floorZ = (engine && engine.FLOOR_FIXTURE_Z) ?? 0.3;
  const lights = design.scenes[0].cue.lights, fixtureById = new Map(rig.fixtures.map((f) => [f.id, f]));
  for (const f of model.fixtures) {
    const fixture = fixtureById.get(f.id);
    if (fixture && fixture.mount.type === "floor") f.pool = overlay.poolOf(fixture, lights[f.id], { ...f, h: floorZ }, model.dims, engine);   // 常に 0.3m で作り直す（h=0 のままだと床狙いでは null・壁狙いでも光源が床に埋まる）
  }
  return model;
}

export class Stage3dRenderer {
  constructor(canvas) {
    this.canvas = canvas; this.ctx = canvas.getContext("2d"); this.data = null;
    this.rig = createDefaultRig(); this.design = createStageDesign(this.rig);
    this.render = window.SHOSAI_LIGHT_RENDER;
    const overlay = window.SHOSAI_STAGE_LIGHT_CUE_OVERLAY;
    const plan = window.SHOSAI_STAGE_LIGHTING_PLAN_OVERLAY;
    if (!window.RIG_ENGINE || !this.render || !overlay || !plan) throw new Error("舞台の描画部品を読み込めません。ページを再読み込みしてください");
    // 幾何はこの1回だけ。setData/視点/時刻の変更ではbuildを呼び直さない。
    this.model = buildStageModel(this.design, this.rig, { overlay, plan, engine: window.RIG_ENGINE });
    this.pools = new Map(this.model.fixtures.filter((f) => f.pool).map((f) => [f.id, f.pool]));
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
  drawFixtures(levels, { litOnly = false } = {}) {
    const fixtures = this.model.fixtures.map((marker) => ({ marker, point: toWorld(marker.u, marker.v, W, D, marker.h) }))
      .sort((a,b) => toCamera(b.point).z - toCamera(a.point).z);
    for (const { marker, point } of fixtures) {
      const value = levels.get(marker.id), led = marker.id.startsWith("led-bar-");
      const alpha = value.level / 100;
      if (litOnly && !(alpha > 0)) continue;
      const fill = alpha > 0 ? colorAtLevel(value.color, alpha) : "#080C13";
      drawBox(this.ctx, { ...point, y: Math.max(led ? 0.03 : 0.12, point.y) }, led ? 0.5 : 0.24, led ? 0.06 : 0.24, fill, alpha > 0 ? fill : "#2C2C30");
    }
  }
  frame(t, { playing = false } = {}) {
    this.resize();
    const ctx = this.ctx, levels = fixtureLevelsAt(t, this.data, this.rig);
    const pools = [...this.pools].map(([id, pool]) => ({ ...pool, ...levels.get(id) })).filter((p) => p.level > 0);
    const P = cueLightProjector(), opts = { topDown: false, tMs: t * 1000, haze: this.render.hazeAmount(35) };
    this.drawShell();
    this.render.paintPools(ctx, pools, P, opts);
    this.render.paintBeams(ctx, pools, P, opts);
    this.drawFixtures(levels);
    this.render.paintWorkLight(ctx, pools, P, { ...opts, floorClip: clipCueLightSurfaces });
    this.drawFixtures(levels, { litOnly: true });   // 暗幕の上に、点いている灯体（LEDバーの自発光）だけ描き直す（γ の redrawLitPieces と同じ順）
    this.render.paintBeams(ctx, pools, P, opts);
    // playingは共通描画器の契約として受け取る。時刻以外で光を変えない。
  }
}
function colorAtLevel(hex, level) {
  const value = parseInt(hex.slice(1), 16);
  return `rgb(${[value >> 16 & 255, value >> 8 & 255, value & 255].map((v) => Math.round(v * level)).join(",")})`;
}
