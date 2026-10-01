// 複製元: show-creative-ideas/stage-sketch-gamma/gamma-light-cue-overlay.js（2026-10-01 時点）。音アタリ側では編集しない。直すときは元を直してから再複製
/* L-1（2026-09-17）: ショー自身の照明デザイン（project.lightingDesign）を、
 * 舞台モードの平面図・正面図へ「概略」として重ねるための読取モデル。
 *
 * 本人指示: 「ライトキューを立てた時に、正面図や平面図に、もしライトキューが
 * 組んであるのであれば反映できるようにしてください。」
 *
 * ★ここは何も書き換えない。project.lightingDesign を読むだけで、複製も保存もしない。
 *
 * ★README の警告を守る: レーザー・カッター・LX cue を、昔の光の描き方へ
 *   機械的に変換しない。表現できないものは**描かずに notes へ入れて、
 *   画面に「ここには出していない」と出す**。誤った絵を出すより黙って省くほうが安全。
 *
 * 取り付け位置（mount → u/v/h）の計算は、既に検証済みの
 * SHOSAI_STAGE_LIGHTING_PLAN_OVERLAY.overlayForPlan をそのまま使い回す。
 * 同じ計算を2つ持つと、片方だけ直したときに図がずれる。
 */
(function (root) {
  "use strict";

  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  const list = (value) => Array.isArray(value) ? value : [];

  /* 劇場プラン用のオーバーレイは「plans[] の1件」を受け取る形なので、
     ショー自身のデザインをその形へ包む（中身は複製しない）。 */
  function planShim(design) {
    if (!record(design) || !record(design.rig)) return null;
    return {
      id: "show-lighting-design",
      label: typeof design.name === "string" ? design.name : "",
      design,
      stageBasis: { dims: record(design.stage) ? design.stage : {} },
    };
  }

  function sceneCue(design, sceneId) {
    const scene = list(design && design.scenes).find((row) => record(row) && row.id === sceneId);
    return scene && record(scene.cue) ? scene.cue : null;
  }

  function point(raw, dims) {
    if (!record(raw)) return null;
    if (raw.coordinateMode === "legacy-panel") {
      return {
        u: finite(raw.u, 0.5), v: finite(raw.v, 0.5), hM: Math.max(0, finite(raw.hM, 0)),
        aheadM: 0, H: Math.max(0, finite(dims && dims.H, 0)), coordinateMode: "legacy-panel",
      };
    }
    return {
      u: clamp(finite(raw.u, 0.5), -0.5, 1.5),
      v: clamp(finite(raw.v, 0.5), -0.5, 1.5),
      hM: Math.max(0, finite(raw.hM, 0)),
      aheadM: Math.max(0, finite(raw.aheadM, 0)),
      H: Math.max(0, finite(dims && dims.H, 0)),
    };
  }

  /* 狙っている場所。動く光は**時刻で動かさない**——図は止まった絵なので、
     線なら両端、円なら中心と半径を返して「この範囲を動く」とだけ示す。
     こうすれば再生していなくても意味が通り、毎フレームの計算も要らない。 */
  function aimOf(light, dims) {
    const path = record(light && light.path) ? light.path : null;
    if (!path) return null;
    if (path.kind === "line") {
      const a = point(path.a, dims);
      const b = point(path.b, dims);
      if (!a || !b) return null;
      return { kind: "line", a, b };
    }
    if (path.kind === "circle") {
      const c = point(path.c, dims);
      if (!c) return null;
      return { kind: "circle", a: c, radiusM: Math.max(0, finite(path.r, 0)), plane: path.plane || "horizontal" };
    }
    const a = point(path.a, dims);
    return a ? { kind: "still", a } : null;
  }

  /* 段階1「光だまり」（2026-09-18）。光が面に落ちた楕円を**世界座標(m)**で返す。
     ★楕円は照明モードが実際に使っている RIG_ENGINE.spotEllipse をそのまま呼ぶ。別実装を書かない。
     ★RIG_ENGINE が読めない環境では null を返す＝光だまりは黙って出ない（段階0のまま）。
     ★面のある光（床・奥の壁）だけ。宙・客席は落ちる面が無いので光だまりを作らない。
     ★レーザーは対象外。普通の光に見せないため（gamma-light-cue-overlay 冒頭の警告）。 */
  const POOL_SURFACES = { floor: true, back: true };
  function worldOf(point, dims) {
    if (!point) return null;
    return {
      x: (finite(point.u, 0.5) - 0.5) * finite(dims.W, 0),
      y: finite(point.v, 0.5) * finite(dims.D, 0),
      z: Math.max(0, finite(point.hM === undefined ? point.h : point.hM, 0)),
    };
  }

  function poolOf(fixture, light, marker, dims, engine) {
    if (!engine || typeof engine.spotEllipse !== "function") return null;
    if (!light || !marker || marker.kind === "laser") return null;
    const surface = typeof light.surface === "string" ? light.surface : "";
    if (!POOL_SURFACES[surface]) return null;
    const source = worldOf(marker, dims);
    const path = record(light.path) ? light.path : null;
    const aimPoint = path && record(path.a) ? path.a : null;
    const target = worldOf(aimPoint, dims);
    if (!source || !target) return null;
    /* 狙い先を面の上へ落とす。軸が面に当たる点が楕円の元なので、
       面から浮いた点をそのまま渡すと楕円の大きさが狂う。 */
    if (surface === "floor") target.z = 0;
    else target.y = 0;
    const deg = typeof engine.beamDegOf === "function" ? engine.beamDegOf(fixture, light) : 18;
    const ellipse = engine.spotEllipse(source, target, deg, surface);
    if (!ellipse || !ellipse.c || !ellipse.ea || !ellipse.eb) return null;
    /* 長軸に沿った濃淡（灯体に近い側が明るい）。斜めに当たるほど光だまりが長く伸びるので、
       これが無いと長い楕円が一様に明るい板に見える（照明モードは常にこれを掛けている）。 */
    const fall = typeof engine.spotFalloff === "function"
      ? engine.spotFalloff(source, ellipse, surface, 8) : null;
    /* 段階2「帯」に要るもの: 出どころ・着地点・着地での光の輪の半径(m)。
       ★輪の半径は光だまりの楕円とは別物。楕円は面を斜めに切った形、輪は光の円錐の断面。
         照明モードも帯の幅にはこちらを使っている（drawBeam の rM）。 */
    const radiusM = typeof engine.spotRadiusM === "function"
      ? engine.spotRadiusM(source, target, deg) : null;
    /* 段階5（2026-09-19 本人決定「光だまりに含める」）: 模様（ゴボ）とカッター。
       光だまりの形そのものなので同じ pool に載せる。角度は描く側で goboAngleAt(…, tMs) に掛ける
       （回転は時計を渡したときだけ動く）。切る線は照明モードと同じ式（frameDoors → doorCutInEllipse）。
       ★どちらも無い灯には鍵を足さない＝これまでの pool と同じ。 */
    const gobo = typeof light.gobo === "string" && light.gobo !== "none" ? light.gobo : null;
    const vert = surface === "back" ? "z" : "y";
    const cuts = (typeof engine.frameDoors === "function" && typeof engine.doorCutInEllipse === "function")
      ? engine.frameDoors(fixture, light, vert)
        .map((door) => engine.doorCutInEllipse(door, ellipse.ea, ellipse.eb))
        .filter(Boolean)
      : [];
    return {
      c: ellipse.c, ea: ellipse.ea, eb: ellipse.eb, surface, fall,
      softness: finite(light.beamEdgeSoftness, 2),
      from: source, to: target, radiusM,
      ...(gobo ? { gobo, goboAngle: finite(light.goboAngle, 0), goboSpin: finite(light.goboSpin, 0),
        goboSoft: finite(light.goboSoft, 6) } : {}),
      ...(cuts.length ? { cuts } : {}),
    };
  }

  /* 段階5①（2026-09-19 本人決定「レーザーを舞台モードへ」）。
     これまでは位置(marker)だけで、狙い・広がり・種類を描いていなかった（notesの「位置だけ」）。
     形の正本は照明モードと同じ LASER_EFFECTS。ここで世界座標のまま光線を組み、
     画面へ落とす（drawProjected）のは共有部品（stage-light-render.js）に任せる。
     ★狙い先は光だまりと同じ約束（動く光でも path.a を止まった代表点として使う。時刻では動かさない）。
     ★複数色プリセット（laserColorPreset）は単色に簡略化する（light.color はプリセットの先頭色と同じ値）。 */
  function laserOf(light, marker, dims, laserEngine) {
    if (!light || !marker || marker.kind !== "laser" || !laserEngine) return null;
    const source = worldOf(marker, dims);
    const path = record(light.path) ? light.path : null;
    const aimPoint = path && record(path.a) ? path.a : null;
    const target = worldOf(aimPoint, dims);
    if (!source || !target) return null;
    const laser = record(light.laser) ? light.laser : {};
    /* 旧 beam はファンの広がり0として読む（照明モードと同じ約束。保存済みデータは書き換えない）。 */
    const effect = laser.effect === "beam" ? "fan" : (typeof laser.effect === "string" ? laser.effect : "fan");
    const spec = laserEngine.EFFECTS[effect] || laserEngine.EFFECTS.fan;
    const spanMin = effect === "tunnel" ? 6 : 0;
    const spanMax = laserEngine.finite(spec.max, effect === "tunnel" ? 60 : 120);
    const spanDeg = laserEngine.clamp(
      laserEngine.finite(laser.spanDeg, laser.effect === "beam" ? 0 : spec.span), spanMin, spanMax);
    const axis = laserEngine.axisBetween(source, target);
    const reach = Math.max(18, finite(dims.W, 0) + finite(dims.D, 0) + finite(dims.H, 0));
    const rays = laserEngine.compile(effect, source, axis, spanDeg, 0, dims, reach, finite(laser.rollDeg, 0));
    const surface = typeof light.surface === "string" ? light.surface : "";
    /* 空中・客席狙いは、狙い点で切らずに図の外まで抜けさせる（照明モードと同じ）。
       床・ホリゾントだけは実際の面（laserLanding）で止める。 */
    if (surface === "air") {
      rays.forEach((ray) => { ray.end = laserEngine.extendedRayPoint(source, ray.dir, reach * 6); });
    } else if (surface === "house") {
      rays.forEach((ray) => { ray.end = laserEngine.houseFarPoint(source, ray.dir, dims, reach * 6) || ray.end; });
    }
    return { rays, effect, surface };
  }

  function build(design, sceneId, overlayApi) {
    const shim = planShim(design);
    if (!shim || !overlayApi || typeof overlayApi.overlayForPlan !== "function") return null;
    const base = overlayApi.overlayForPlan(shim);
    if (!base) return null;
    const cue = sceneCue(design, sceneId);
    const lights = cue && record(cue.lights) ? cue.lights : {};
    const dims = base.dims;

    let lit = 0;
    let unset = 0;
    const engine = root.RIG_ENGINE || null;
    const laserEngine = root.LASER_EFFECTS || null;
    const rigFixtures = list(design && design.rig && design.rig.fixtures);
    const fixtureById = new Map(rigFixtures.filter(record).map((row) => [row.id, row]));
    const fixtures = base.markers.map((marker) => {
      const light = record(lights[marker.id]) ? lights[marker.id] : null;
      /* on は true / false / null（未設定）の3値。未設定を消灯と言い切らない。 */
      const state = !light || light.on === null || light.on === undefined
        ? "unset" : (light.on ? "on" : "off");
      if (state === "on") lit += 1;
      if (state === "unset") unset += 1;
      return {
        id: marker.id,
        kind: marker.kind,
        u: marker.u,
        v: marker.v,
        h: marker.h,
        outside: marker.outside,
        state,
        level: light ? clamp(finite(light.level, 100), 0, 100) : 0,
        color: light && /^#[0-9a-f]{6}$/i.test(String(light.color)) ? light.color : "#f2ead6",
        surface: light && typeof light.surface === "string" ? light.surface : "",
        aim: state === "on" && marker.kind !== "laser" ? aimOf(light, dims) : null,
        pool: state === "on" ? poolOf(fixtureById.get(marker.id), light, marker, dims, engine) : null,
        laser: state === "on" ? laserOf(light, marker, dims, laserEngine) : null,
      };
    });

    /* 図にしていないもの。黙って省かずに、画面へ「出していない」と書くための材料。 */
    const notes = [];
    const lasers = fixtures.filter((row) => row.kind === "laser" && row.state === "on").length;
    if (lasers) notes.push({ key: "laser", count: lasers });
    const lxq = list(design.scenes).reduce((sum, scene) =>
      sum + (record(scene) && Array.isArray(scene.lxq) ? scene.lxq.length : 0), 0);
    if (lxq) notes.push({ key: "lxq", count: lxq });

    /* 場面のもや（R-2・2026-09-19）。照明を組む画面の値（0〜100・未設定は35）をそのまま持つ。振れ幅への写しは共有部品 hazeAmount。 */
    const environment = cue && record(cue.environment) ? cue.environment : null;
    return {
      sceneId: typeof sceneId === "string" ? sceneId : "",
      hasCue: Boolean(cue),
      environment: { haze: environment ? clamp(finite(environment.haze, 35), 0, 100) : 35 },
      dims,
      trusses: base.trusses,
      fixtures,
      counts: { total: fixtures.length, lit, unset, laser: base.counts.laser,
        pools: fixtures.filter((row) => row.pool).length },
      notes,
    };
  }

  const api = Object.freeze({ build, aimOf, planShim, poolOf });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SHOSAI_STAGE_LIGHT_CUE_OVERLAY = api;
})(typeof window !== "undefined" ? window : globalThis);
