/* 「照明デザインモード」試作 — 幾何と時間の純関数（DOM・描画を持たない）
 * 旧称「照明を組む」（2026-09-13 本人決定で改名）
 *
 * 設計の根拠:
 *   ../codex-round1.answer.md（第1ラウンド）… 灯体はショー共通(rig)／点灯・動きはシーンごと(cue)。
 *     一灯の軌道が基本。扇・交差・順にには「組」の構成。「向かい合わせ」は軌道の鏡映。
 *   ../codex-round3.answer.md（第3ラウンド・2026-09-11）… 狙い点は「面ごとに座標の意味を変える」
 *     のをやめ、常に3D点 {u,v,hM} として持つ（ETC Augment3dのXYZ Programmingと同じ考え方）。
 *     円には軌道面（水平／正面に垂直／側面に垂直）を持たせ、空中芸の縦円・斜め軌道に対応する。
 *
 * 座標の契約（本体 stage-sketch.js と同じ）:
 *   u: 左右 0..1（0=下手側、1=上手側）／ v: 奥行き 0..1（0=最奥、1=最前＝客席側）
 *   世界座標: x=(u-0.5)*W [m], y=v*D [m], z=高さ [m]
 *   狙い点は Point3 = {u, v, hM}（hM=床からの高さm）。UIの「当てる場所」は制約であり、
 *   データ上は floor/back/air のどれでも同じ Point3 を使う（floor: hM=0固定 ／ back: v=0固定 ／ air: 自由）。
 *
 * 機材の型番・回路・DMX・照度は持たない（案を照明担当者へ渡すための道具）。
 */
(function (root) {
  "use strict";

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const finite = (v, f) => (Number.isFinite(Number(v)) ? Number(v) : f);

  /* ---------- 既定 ---------- */
  const DEFAULT_DIMS = Object.freeze({ W: 12, D: 8, H: 8 });
  const FLOOR_FIXTURE_Z = 0.3;   // 床置きの光源の高さ。実測ではなく描画上の仮定
  const SIDE_OFFSET_M = 1;       // SSは舞台端から袖裏へ1m離す（表示用の仕込み位置）
  /* ホリゾントライト（地明かり／上部）は奥の壁（ホリゾント幕）のすぐ手前に置く実機の
     置き方に合わせる（2026-09-13 本人要望）。v をわずかに手前へ取るのは、壁ぴったり(v=0)だと
     幕の板と重なって描画が競合するのを避けるため——実機でも幕を焼かないよう少し離して置く。
     2026-09-13 本人指摘で作り直し: 個別に並べるものではなく「もとから一列のバー」で、
     壁全体を染める前提。幅は常に舞台幅100%で、利用者が長さを変える値は持たない。
     置き方は rung（floor=床から上向き／top=上部から下向き）だけ。fixtureWorld は選択や
     アイコンの基準になる「バーの中心点」を返し、実際の左右端は cycBarSpan で別に持つ。 */
  const CYC_MOUNT_V = 0.02;
  const CYC_REACH_MAX = 10;     // 届く高さの上限(m)。2026-09-13 本人指定
  /* 客席へ向けた光（surface: "house"）の狙い点は舞台の手前端(v=1)から aheadM(m) だけ客席側。
     前明かりの ahead と同じ考え方で、上限も同じ20m（2026-09-13 本人要望「当てる場所に客席方面」）。 */
  const HOUSE_AHEAD_MAX = 20;
  /* バーの世界座標での帯。xL/xRは常に舞台の左右端、y＝奥行き、z0＝光源の高さ
     （床=0／上部=dims.H）、reach＝既定の壁面ウォッシュ高。壁より高くは出しても
     見えないので、描くときに壁の高さで止める。 */
  const cycBarSpan = (fixture, dims) => {
    const m = (fixture && fixture.mount) || {};
    const half = dims.W / 2;
    const top = m.rung === "top";
    const reach = clamp(finite(m.reachM, 4), 0.3, CYC_REACH_MAX);
    return { xL: -half, xR: half, y: CYC_MOUNT_V * dims.D, z0: top ? dims.H : 0, top, reach };
  };
  const SPEED_PERIOD_MS = Object.freeze({ slow: 6000, normal: 3000, fast: 1500 });
  const PLANE_VALUES = Object.freeze(["horizontal", "frontVertical", "sideVertical"]);

  /* ---------- rig（ショー共通） ---------- */
  const newTruss = (id, v, h, label) => ({ id, v: clamp(finite(v, 0.2), 0, 1), h: clamp(finite(h, 6), 2, 14), label: label || "" });

  // mount: {type:"truss", trussId, u} | {type:"floor", u, v} | {type:"side", side:"kamite"|"shimote", v, h}
  /* kind: "moving"＝ムービング（動きを付けられる）／"fixed"＝固定（向きは仕込みで決まる）。
     既定はムービング。fixed の灯には往復・円を付けさせない（2026-09-11 本人要望）。 */
  const newFixture = (id, no, mount, name, kind, beamDeg) => ({
    id, no, name: name || "", mount,
    kind: kind === "laser" ? "laser" : kind === "mirrorball" ? "mirrorball" : kind === "fixed" ? "fixed" : "moving",
    // 光の広がり（度）。ムービングのズーム範囲は実機で 7°〜50°（PLUTO600 PROFILE MK2）。
    // 固定灯はランプ／レンズで決まり、ショー中は変えられない（PARは玉を替えるしかない）。
    beamDeg: clamp(finite(beamDeg, 16), 4, 70),
  });
  const isMoving = (fixture) => Boolean(fixture) && fixture.kind !== "fixed" && fixture.kind !== "laser" && fixture.kind !== "mirrorball";
  const isLaser = (fixture) => Boolean(fixture) && fixture.kind === "laser";
  /* ミラーボール（2026-10-03・docs/mirror-ball-plan-2026-10-03/DESIGN.md）。灯体の種類のひとつ。
     吊り物なのでバトンに付ける。持つのは直径と回る速さだけ（型番・モーター種別・DMXは持たない＝機材はモデル化しない）。
     ピンスポットは既存の灯体で、cue の light.target = { fixtureId: 球のid } で「この光が球を照らしている」と結ぶ。
     surface は "air" のまま・path.a は球の中心（旧版のための代表点）＝新しい列挙値は kind だけ。
     ★「mirror」の語は組の鏡映（mirrorMount 等）で使っているので、ここは必ず mirrorBall と書く。 */
  const MIRROR_BALL = Object.freeze({
    diametersM: Object.freeze([0.2, 0.3, 0.45]),   // Panasonic φ203/305/407・丸茂 φ300/450 を丸めた
    rpms: Object.freeze([0, 1, 1.5, 3]),           // 定速型 1〜1.2rpm・モーター単体 1〜1.5rpm・変速型 〜4.5rpm
    defaults: Object.freeze({ diameterM: 0.3, rpm: 1 }),
    hangM: 0.3,                                    // バトンから球の天辺までの吊り代（モーター分）
    pinBeamDeg: 6,                                 // ピンスポットの既定の広がり（実機の値は未確認）
    pinWideDeg: 10,                                // これより広いピンには「細くする」注記を出す
  });
  const isMirrorBall = (fixture) => Boolean(fixture) && fixture.kind === "mirrorball";
  const mirrorBallOf = (fixture) => {
    const m = (fixture && fixture.mirrorBall) || {};
    return { diameterM: clamp(finite(m.diameterM, MIRROR_BALL.defaults.diameterM), 0.1, 1.0),
      rpm: clamp(finite(m.rpm, MIRROR_BALL.defaults.rpm), 0, 6) };
  };
  /* 色の作り方（2026-09-28）。fixture.colorMode:"wheel"＝カラーホイール機。CMY/RGB のように途中の色を作れないので、
     キューの間はスナップの遅れの後に一瞬で替わり、動きの中（colorTo）は位相の半分で一瞬で替わる。無ければ混色（"mix"）。 */
  const colorSnaps = (fixture) => Boolean(fixture) && fixture.colorMode === "wheel";
  /* いま実際に出ている広がり。ムービングだけ、このシーンのズーム（light.beamDeg）で上書きできる。
     固定灯は仕込みの値（fixture.beamDeg）のまま。 */
  const beamDegOf = (fixture, light) => {
    const base = clamp(finite(fixture && fixture.beamDeg, 16), 4, 70);
    if (!isMoving(fixture) || !light || light.beamDeg == null) return base;
    return clamp(finite(light.beamDeg, base), 4, 70);
  };
  /* Only explicitly classified fixtures use the new optical defaults. Legacy
     fixtures keep the former value of 2, regardless of fixtureType metadata. */
  const opticalSoftnessOf = (fixture, light) => {
    if (light && light.beamEdgeSoftness != null) return clamp(finite(light.beamEdgeSoftness, 2), 0, 10);
    return fixture && fixture.opticalType === "wash" ? 7
      : fixture && fixture.opticalType === "spot" ? 1 : 2;
  };
  /* 光は狙った点で止まらない。そこを過ぎた光は床か奥の壁まで進み、どちらにも当たらなければ
     図の外へ抜けていく（本体 stage-sketch.js の beamLanding と同じ考え方）。
     床(z=0)と奥の壁(y=0)だけが遮る面。袖と客席側は開いている。
     返り値の on は "floor" / "back" / null（何にも当たらず抜ける）。 */
  const beamLanding = (S, T, dims) => {
    const dx = T.x - S.x, dy = T.y - S.y, dz = T.z - S.z;
    let best = Infinity, on = null;
    const hit = (t, kind) => { if (t > 1e-4 && t < best) { best = t; on = kind; } };
    if (dz < -1e-6) hit((0 - S.z) / dz, "floor");
    if (dy < -1e-6) hit((0 - S.y) / dy, "back");
    const len = Math.hypot(dx, dy, dz) || 1;
    const t = on ? best : (Math.hypot(dims.W, dims.D, dims.H) * 1.6) / len;
    return { x: S.x + dx * t, y: S.y + dy * t, z: S.z + dz * t, on, t };
  };

  // 照射先での光の輪の半径(m)。距離×tan(広がり/2)
  const spotRadiusM = (S, T, deg) => {
    const d = Math.hypot(T.x - S.x, T.y - S.y, T.z - S.z);
    return Math.max(0.12, d * Math.tan(clamp(finite(deg, 18), 4, 70) * Math.PI / 360));
  };

  /* 面に当たった光の形。円錐を斜めに切ると円ではなく楕円になる（2026-09-13 本人要望）。
     丸いのは真下（床）・真正面（奥の壁）に落としたときだけ。

     S＝灯体、T＝軸が面に当たる点、deg＝広がり（全角）、surface＝"floor"(z=0) か "back"(y=0)。
     返すのは面の上の楕円で、c＝中心、ea＝長半径ベクトル、eb＝短半径ベクトル（世界座標m）。
     ＊中心は T ではない。斜めになるほど灯体から遠い側へずれる。

     導き方: 頂点A・軸u・半角θ・面の法線n とし、面上の点Pで (P−A)·u = |P−A|cosθ を解く。
     Aの真下を原点、傾いた向きをxに取ると
       K x² + cos²θ y² − 2H sinφcosφ x − H²(cos²φ − cos²θ) = 0   （K = cos²θ − sin²φ）
     で、平方完成すると右辺が H²cos²θsin²θ/K にまとまる。そこから
       長半径 a = H cosθ sinθ / K、短半径 b = H sinθ / √K、中心のずれ = H tanφ sin²θ / K
     （H＝灯体から面までの垂線、φ＝軸と法線のなす角）。φ=0 なら a=b=H tanθ で円に戻る。 */
  const spotEllipse = (S, T, deg, surface) => {
    if (!S || !T) return null;
    const n = surface === "back" ? { x: 0, y: 1, z: 0 } : surface === "floor" ? { x: 0, y: 0, z: 1 } : null;
    if (!n) return null;
    const th = (clamp(finite(deg, 18), 4, 70) * Math.PI) / 360;      // 半角
    const wx = T.x - S.x, wy = T.y - S.y, wz = T.z - S.z;
    const d = Math.hypot(wx, wy, wz);
    if (!(d > 1e-6)) return null;
    const ux = wx / d, uy = wy / d, uz = wz / d;
    const cosPhi = -(ux * n.x + uy * n.y + uz * n.z);
    if (!(cosPhi > 1e-3)) return null;            // 面と平行、または裏から当たっている
    const H = d * cosPhi;                         // 灯体から面までの垂線の長さ
    // 面に沿う向き（軸の面内成分）。長さは sinφ
    let ex = ux + cosPhi * n.x, ey = uy + cosPhi * n.y, ez = uz + cosPhi * n.z;
    const sinPhi = Math.min(1, Math.hypot(ex, ey, ez));
    if (sinPhi < 1e-6) { ex = 1; ey = 0; ez = 0; }            // 真っすぐ当たっている＝円
    else { ex /= sinPhi; ey /= sinPhi; ez /= sinPhi; }
    const cosTh = Math.cos(th), sinTh = Math.sin(th);
    /* K が0に近い＝面をなめる角度。本来は放物線・双曲線になって無限に伸びるが、
       図としては意味がないので「長いほう÷短いほう」が6倍を超えないところで止める。 */
    const K = Math.max(cosTh * cosTh - sinPhi * sinPhi, (cosTh * cosTh) / 36);
    const a = (H * cosTh * sinTh) / K;
    const b = (H * sinTh) / Math.sqrt(K);
    const off = (H * (sinPhi / cosPhi) * sinTh * sinTh) / K;
    const fx = n.y * ez - n.z * ey, fy = n.z * ex - n.x * ez, fz = n.x * ey - n.y * ex;   // n × e
    return {
      c: { x: T.x + ex * off, y: T.y + ey * off, z: T.z + ez * off },
      ea: { x: ex * a, y: ey * a, z: ez * a },
      eb: { x: fx * b, y: fy * b, z: fz * b },
      a, b, off, tiltDeg: (Math.asin(sinPhi) * 180) / Math.PI,
    };
  };

  /* 光だまりの中の明るさの落ち方（2026-09-13 本人要望）。
     斜めに当たると遠い側ほど暗い。理由は2つで、どちらも掛け算で効く:
       ・距離が伸びるぶん薄まる（距離の二乗に反比例）
       ・面に浅く当たるぶん、同じ光が広い面積へ延びる（入射角の余弦。ランバートの余弦則）
     長軸に沿って t=−1（灯体に近い側）〜+1（遠い側）で標本を取り、
     いちばん明るいところが1になるようそろえて返す。
     ＊そろえるのは「灯ごとの明るさの差」を変えないため。ここで足すのは光だまりの中の濃淡だけ。 */
  const spotFalloff = (S, el, surface, steps) => {
    if (!S || !el) return null;
    const n = surface === "back" ? { x: 0, y: 1, z: 0 } : surface === "floor" ? { x: 0, y: 0, z: 1 } : null;
    if (!n) return null;
    const N = Math.max(2, Math.round(finite(steps, 8)));
    const out = [];
    for (let i = 0; i <= N; i++) {
      const t = -1 + (2 * i) / N;
      const px = el.c.x + el.ea.x * t, py = el.c.y + el.ea.y * t, pz = el.c.z + el.ea.z * t;
      const dx = S.x - px, dy = S.y - py, dz = S.z - pz;
      const r2 = Math.max(dx * dx + dy * dy + dz * dz, 1e-6), r = Math.sqrt(r2);
      const cosI = Math.max(0, (dx * n.x + dy * n.y + dz * n.z) / r);
      out.push({ t, v: cosI / r2 });
    }
    const mx = out.reduce((m, o) => Math.max(m, o.v), 0);
    if (!(mx > 0)) return null;
    return out.map((o) => ({ t: o.t, v: clamp(o.v / mx, 0, 1) }));
  };

  /* ---------- バーンドア／カッター（2026-09-14 本人要望） ----------
     バーンドア: 固定灯だけの装備。四方（床・空中なら 奥・手前・下手・上手／奥の壁・客席なら 上・下・下手・上手）
       から光の縁を切る。fixture.barn = { back, front, left, right } 各 0〜1（0＝開いている、1＝中心まで閉める）。
       仕込みで決める値なので全シーン共通（fixture.beamDeg と同じ層）。ムービングには付けない（本人指定）。
     カッター: 光を四角にする。light.shutter = { on, w, h }。このシーンの値（ゴボと同じ層）。
       w/h は「光の輪に内接する正方形の辺」を1とした比。1.4（≒√2）まで上げるとその向きは輪の外まで開き、
       もう一方だけが効いた「帯」になる。細かい調整はしない（本人指定「四角形、異なるサイズの四角形」）。
     どちらも「切る線」の集まりに直してから描く: 世界座標の向き n（外向き）と、中心からの距離（光の半径＝1）。
     縁の柔らかさ soft も半径に対する比。バーンドアは柔らかく、カッターは硬い。 */
  const BARN_KEYS = Object.freeze(["back", "front", "left", "right"]);
  const BARN_SOFT = 0.22, SHUTTER_SOFT = 0.04;
  const SHUTTER_MIN = 0.1, SHUTTER_MAX = 1.4;
  /* 形の見本（正方形／横長…）は 2026-09-14 本人指摘で廃止: 幅と奥行きで作れるので要らない。代わりに回転（rot、度）を持つ。 */
  const SHUTTER_ROT_MAX = 90;
  const newShutter = (over = {}) => ({ on: true, w: 1, h: 1, rot: 0, ...over });
  const barnOf = (fixture) => {
    const b = (fixture && fixture.barn) || {}; const o = {};
    BARN_KEYS.forEach((k) => { o[k] = clamp(finite(b[k], 0), 0, 1); });
    return o;
  };
  const barnActive = (fixture) => Boolean(fixture) && !isMoving(fixture) && BARN_KEYS.some((k) => barnOf(fixture)[k] > 0);
  const shutterActive = (light) => Boolean(light && light.shutter && light.shutter.on);
  /* 切る線（世界座標）。vert = "y"（床・空中: 奥⇄手前が y 軸、奥＝−y）／"z"（奥の壁・客席: 上⇄下が z 軸、上＝+z）。
     返り値 [{ key, n:{x,y,z}, f, soft }]。f は中心までを1とした閉め具合。 */
  const frameDoors = (fixture, light, vert) => {
    const out = [];
    const up = vert === "z" ? { x: 0, y: 0, z: 1 } : { x: 0, y: -1, z: 0 };
    const axis = { back: up, front: { x: -up.x, y: -up.y, z: -up.z }, left: { x: -1, y: 0, z: 0 }, right: { x: 1, y: 0, z: 0 } };
    if (barnActive(fixture)) {
      const b = barnOf(fixture);
      BARN_KEYS.forEach((k) => { if (b[k] > 0) out.push({ key: k, n: axis[k], f: b[k], soft: BARN_SOFT }); });
    }
    if (shutterActive(light)) {
      const s = light.shutter;
      const fw = 1 - clamp(finite(s.w, 1), SHUTTER_MIN, SHUTTER_MAX + 0.1) / Math.SQRT2;
      const fh = 1 - clamp(finite(s.h, 1), SHUTTER_MIN, SHUTTER_MAX + 0.1) / Math.SQRT2;
      /* 回転（2026-09-14 本人要望）: 面の中（x と up が張る面）で四角を回す。バーンドアは回さない（舞台軸に固定）。
         正の角で、床なら真上から見て時計回り（x → 奥 の向き）、奥の壁なら客席から見て反時計回り（x → 上）。 */
      const th = (clamp(finite(s.rot, 0), -180, 180) * Math.PI) / 180, cs = Math.cos(th), sn = Math.sin(th);
      const rx = { x: cs, y: sn * up.y, z: sn * up.z }, ru = { x: -sn, y: cs * up.y, z: cs * up.z };
      const neg = (v) => ({ x: -v.x, y: -v.y, z: -v.z });
      if (fw > 0) { out.push({ key: "left", n: neg(rx), f: fw, soft: SHUTTER_SOFT }); out.push({ key: "right", n: rx, f: fw, soft: SHUTTER_SOFT }); }
      if (fh > 0) { out.push({ key: "back", n: ru, f: fh, soft: SHUTTER_SOFT }); out.push({ key: "front", n: neg(ru), f: fh, soft: SHUTTER_SOFT }); }
    }
    return out;
  };
  /* 面の上の楕円（spotEllipse の ea, eb）の座標系で見た切る線。単位円＝光の輪。
     世界座標の点 = c + x·ea + y·eb なので、向き n に沿った座標は x·(ea·n) + y·(eb·n)。
     楕円の n 方向の半径は √((ea·n)²+(eb·n)²) だから、そこを1にそろえると
     「p·m > d の側を切る」（m = ((ea·n),(eb·n))/半径、d = 1−f）という単位円の上の直線になる。
     n が面に垂直（床の上で z 軸など）なら半径0で線が引けない＝その面では切らない（null）。 */
  const doorCutInEllipse = (door, ea, eb) => {
    const n = door.n;
    const A = ea.x * n.x + ea.y * n.y + ea.z * n.z, B = eb.x * n.x + eb.y * n.y + eb.z * n.z;
    const e = Math.hypot(A, B);
    if (!(e > 1e-9)) return null;
    return { mx: A / e, my: B / e, d: 1 - clamp(finite(door.f, 0), 0, 1), soft: finite(door.soft, SHUTTER_SOFT) };
  };

  /* 投影済みの光だまり（単位円をアフィン変換した形）から、灯体に見える左右の輪郭点を返す。
     カッター／バーンドアを同じ単位円で切ってから接線を探すため、帯だけ元の円の幅に
     残ることがない。soft は光だまりの半影が完全に消える外縁まで含める。 */
  const beamLandingSilhouette = (from, pool, cuts = []) => {
    if (!from || !pool || ![from.X, from.Y, pool.cx, pool.cy, pool.ax, pool.ay, pool.bx, pool.by].every(Number.isFinite)) return null;
    const count = 192;
    let polygon = Array.from({ length: count }, (_, i) => {
      const a = (i / count) * Math.PI * 2;
      return { x: Math.cos(a), y: Math.sin(a) };
    });
    for (const cut of cuts) {
      if (!cut || ![cut.mx, cut.my, cut.d].every(Number.isFinite)) continue;
      const edge = cut.d + Math.max(0, finite(cut.soft, 0));
      const side = (p) => cut.mx * p.x + cut.my * p.y - edge;
      const next = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i], b = polygon[(i + 1) % polygon.length];
        const da = side(a), db = side(b);
        if (da <= 0) next.push(a);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const t = da / (da - db);
          next.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
      }
      polygon = next;
      if (polygon.length < 2) return null;
    }
    const points = polygon.map((p) => ({ X: pool.cx + pool.ax * p.x + pool.bx * p.y,
      Y: pool.cy + pool.ay * p.x + pool.by * p.y }));
    const middle = points.reduce((a, p) => ({ X: a.X + p.X / points.length, Y: a.Y + p.Y / points.length }), { X: 0, Y: 0 });
    const dx = middle.X - from.X, dy = middle.Y - from.Y;
    if (Math.hypot(dx, dy) < 1) return null;
    let min = null, max = null;
    for (const p of points) {
      const vx = p.X - from.X, vy = p.Y - from.Y;
      const angle = Math.atan2(dx * vy - dy * vx, dx * vx + dy * vy);
      if (!min || angle < min.angle) min = { angle, point: p };
      if (!max || angle > max.angle) max = { angle, point: p };
    }
    if (!min || !max || max.angle - min.angle >= Math.PI ||
        Math.hypot(max.point.X - min.point.X, max.point.Y - min.point.Y) < 1) return null;
    return { cornerP: max.point, cornerM: min.point };
  };

  const trussById = (rig, id) => (rig.trusses || []).find((t) => t.id === id) || null;

  // 奥から何段目（1始まり）。表示専用。保存はしない
  const trussRow = (rig, trussId) => {
    const sorted = [...(rig.trusses || [])].sort((a, b) => a.v - b.v);
    const i = sorted.findIndex((t) => t.id === trussId);
    return i < 0 ? null : i + 1;
  };

  // 灯体の世界座標（光源）
  const fixtureWorld = (fixture, rig, dims = DEFAULT_DIMS) => {
    const m = fixture.mount || {};
    if(m.type === "position"){try{return root.GAMMA_LIGHT_MODEL.positionLayout.world(rig,m,dims);}catch(_){return null;}}
    if (m.type === "truss") {
      const t = trussById(rig, m.trussId);
      if (!t) return null;
      return { x: (clamp(finite(m.u, 0.5), 0, 1) - 0.5) * dims.W, y: t.v * dims.D, z: t.h };
    }
    /* 旧ベータの照明パネルは、仕込み種別ではなく任意の u/v/h を持っていた。
       コピー変換した v2 だけがこの型を使う。舞台外の前明かり・袖明かりも
       原値のまま見比べるため、ここでは 0..1 や舞台高へ丸めない。 */
    if (m.type === "legacy-panel") {
      if (![m.u, m.v, m.h].every(Number.isFinite)) return null;
      return { x: (m.u - 0.5) * dims.W, y: m.v * dims.D, z: m.h };
    }
    if (m.type === "floor") {
      return { x: (clamp(finite(m.u, 0.5), 0, 1) - 0.5) * dims.W, y: clamp(finite(m.v, 0.5), 0, 1) * dims.D, z: FLOOR_FIXTURE_Z };
    }
    if (m.type === "side") {
      const sign = m.side === "shimote" ? -1 : 1; // 下手=左=負、上手=右=正
      return { x: sign * (dims.W / 2 + SIDE_OFFSET_M), y: clamp(finite(m.v, 0.5), 0, 1) * dims.D, z: clamp(finite(m.h, 2), 0.3, 14) };
    }
    /* 前明かり（シーリング／フロントサイド）。客席の上にあるので舞台より手前（y > D）。
       ahead = 舞台の手前端からの距離(m)。高さは客席天井なので舞台のHを超えてよい。 */
    if (m.type === "front") {
      return { x: (clamp(finite(m.u, 0.5), 0, 1) - 0.5) * dims.W, y: dims.D + clamp(finite(m.ahead, 5), 0.5, 20), z: clamp(finite(m.h, 7), 1, 20) };
    }
    /* ホリゾントライト（地明かり）。奥の壁ぎわ・床に置き、横位置(u)だけを持つ。
       高さ0＝床に置いた実機、奥行きは壁のすぐ手前で固定（袖のブームや前明かりと同じく
       「取り付け方で決まる」位置なので、動かせるのは横位置だけでよい）。 */
    if (m.type === "cyc") {
      return { x: 0, y: CYC_MOUNT_V * dims.D, z: m.rung === "top" ? dims.H : 0 };   // 横は中央固定
    }
    return null;
  };

  /* ミラーボールの中心（世界座標m）。取り付け点から吊り代と半径だけ下。床より下へは行かない。 */
  const mirrorBallCentre = (fixture, rig, dims = DEFAULT_DIMS) => {
    const S = fixtureWorld(fixture, rig, dims); if (!S) return null;
    const R = mirrorBallOf(fixture).diameterM / 2;
    return { x: S.x, y: S.y, z: Math.max(R, S.z - MIRROR_BALL.hangM - R) };
  };
  /* ピンの狙い点（旧版のための代表点）。球の中心を Point3 {u,v,hM} へ戻す。 */
  const mirrorBallAimPoint = (fixture, rig, dims = DEFAULT_DIMS) => {
    const C = mirrorBallCentre(fixture, rig, dims); if (!C) return null;
    return { u: clamp(C.x / dims.W + 0.5, 0, 1), v: clamp(C.y / dims.D, 0, 1), hM: clamp(C.z, 0, dims.H) };
  };
  /* この光が照らしている球（light.target.fixtureId）。無い・球でない なら null。 */
  const mirrorBallTargetOf = (light, rig) => {
    const id = light && light.target && typeof light.target.fixtureId === "string" ? light.target.fixtureId : "";
    if (!id || !rig || !Array.isArray(rig.fixtures)) return null;
    const ball = rig.fixtures.find((row) => row && row.id === id);
    return isMirrorBall(ball) ? ball : null;
  };

  /* ---------- cue（シーンごと） ----------
   * Point3 = { u: 0..1, v: 0..1, hM: 床からの高さm }
   * cue.lights[fixtureId] = {
   *   on: true|false|null(未設定), color: "#rrggbb",
   *   level: 0..100,                   // 強さ（調光）。0は消灯と同じ扱い（2026-09-13 本人決定）。
   *   levelTo: 0..100 | 省略,          // 動きの中で強さを変えるときの「終わり」の値（ムービングのみ）。
   *   beamDegTo: 4..70 | 省略,         // 同じく「終わり」の広がり（ズーム）。始めは level / beamDeg。
   *   gobo: "none"|GOBOSのid,          // 光に載せる模様（ゴボ）。既定は "none"
   *   goboSpin: -100..100,             // 模様を回す速さと向き（0=止める、負=反時計回り）
   *   goboAngle: 0..360,               // 止めているときの角度（度）
   *   goboSoft: 0..100,                // 模様のぼけ具合（0=くっきり。実際に使うのは0〜30で、UIは10等分）
   *                                    // 位置の往復と同じ位相で 始め→終わり→始め と往復する（2026-09-13 本人要望）。
   *                                    // 目盛りそのものはリニア。見える明るさへの効き方（カーブ）は
   *                                    // アプリ全体で1つの設定として app.js 側が持つ。
   *   surface: "floor"|"back"|"air"|"house",   // UI上の制約プリセット。house＝客席へ向ける（狙い点は aheadM を持つ）
   *   path:
   *       {kind:"still", a:Point3}
   *     | {kind:"line", a:Point3, b:Point3, start:"a"|"b"}                       // 高さも別々に持てる＝斜め往復
   *     | {kind:"circle", c:Point3, r:number(m), plane:"horizontal"|"frontVertical"|"sideVertical", dir:"cw"|"ccw", start:0..1}
   *   speed: "slow"|"normal"|"fast", groupId: string|null
   * }
   * cue.groups = [{ id, members:[fixtureId...](順序あり), relation:"together"|"mirror"|"sequential", delayMs }]
   */
  const newPoint = (over = {}) => ({ u: 0.5, v: 0.5, hM: 0, ...over });

  const newLightCue = (over = {}) => ({
    on: true, level: 100, color: "#f2ead6", surface: "floor",
    path: { kind: "still", a: newPoint() },
    speed: "normal", groupId: null, ...over,
  });

  // 「当てる場所」を切り替えたとき、Point3へ制約を適用する（floor: hM=0／back: v=0／air: 自由）
  const constrainPointToSurface = (p, surface, dims) => {
    const q = { u: clamp(finite(p && p.u, 0.5), 0, 1), v: clamp(finite(p && p.v, 0.5), 0, 1), hM: clamp(finite(p && p.hM, 0), 0, dims.H) };
    if (surface === "floor") q.hM = 0;
    else if (surface === "back") { q.v = 0; if (q.hM <= 0) q.hM = clamp(dims.H * 0.5, 0.5, dims.H); }
    else if (surface === "air" && q.hM <= 0) q.hM = clamp(4, 0.5, dims.H);
    /* 客席: 手前端(v=1)から aheadM だけ客席側。高さは舞台の床から測る。
       既定の 1.2m は座った観客の目の高さ寄り（舞台が客席床より約1m高いぶん、目線は舞台床の少し上）。 */
    else if (surface === "house") { q.v = 1; q.aheadM = clamp(finite(p && p.aheadM, 6), 0.5, HOUSE_AHEAD_MAX); if (q.hM <= 0) q.hM = clamp(1.2, 0, dims.H); }
    return q;
  };

  /* 1往復（1周）の時間。任意の秒数 periodSec を持っていればそれが優先。
     持っていなければ従来どおり speed の3段（2026-09-12 本人要望で秒数指定を追加）。 */
  const periodMs = (light) => {
    if (light && light.path && light.path.kind === "poly") return polyCycleMs(light.path);
    const sec = light && light.periodSec;
    if (Number.isFinite(Number(sec)) && Number(sec) > 0) return clamp(Number(sec), 0.2, 120) * 1000;
    return SPEED_PERIOD_MS[light && light.speed] || SPEED_PERIOD_MS.normal;
  };

  const tri = (t) => { const m = ((t % 1) + 1) % 1; return m < 0.5 ? m * 2 : 2 - m * 2; };
  const saw = (t) => ((t % 1) + 1) % 1;

  /* ===== 実機・卓の「時間」を再現する追加（2026-09-27 テスト用ビルド） =====
     設計: docs/light-real-effects-plan-2026-09-27/index.html（本人が推奨5点を承認）
     ① curveMap: フェードの道筋。数値2つ（accel/decel −100〜200%）で grandMA3 の Transition 9種を近似。
        −100=なめらか（正弦寄り）／0=一定／200=急。式はCSSと同じ3次ベジェ（内部式は非公開なので近似）。
     ② poly: 決めた点を順に回る軌道（多角形・稲妻・A→B→C・跳び）。各点に「止まる秒」「動く秒」。
     ③ timing / blendCues: キューの時間（フェード・遅れ・カーブ・スナップ・ムーブインブラック）。
        前の状態と次の状態を混ぜた「描画用のキュー」を返す。描画側はこれまでどおりのキューを読むだけ。
     ★どの鍵も省略可。無ければ今までの挙動（カット／端で減速する往復）と同じ。 */
  const CURVE_PRESETS = Object.freeze({
    linear: { accel: 0, decel: 0 },
    ease: { accel: -100, decel: -100 },
    easeIn: { accel: -100, decel: 100 },
    easeOut: { accel: 100, decel: -100 },
    swing: { accel: -100, decel: -100, overshoot: 25 },
  });
  const normalizeCurve = (raw) => {
    if (typeof raw === "string") return CURVE_PRESETS[raw] ? normalizeCurve(CURVE_PRESETS[raw]) : null;
    if (!raw || typeof raw !== "object") return null;
    return { accel: clamp(finite(raw.accel, 0), -100, 200), decel: clamp(finite(raw.decel, 0), -100, 200), overshoot: clamp(finite(raw.overshoot, 0), 0, 60) };
  };
  const cubicBezierY = (x1, y1, x2, y2, x) => {
    const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
    const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
    let lo = 0, hi = 1, t = x;
    for (let i = 0; i < 28; i += 1) { const v = bx(t); if (Math.abs(v - x) < 1e-6) break; if (v < x) lo = t; else hi = t; t = (lo + hi) / 2; }
    return by(t);
  };
  /* 進み具合 p（0〜1）を、カーブで置き換えた進み具合にする。swing は 1 を越えてから戻る。 */
  const curveMap = (p, curve) => {
    const c = normalizeCurve(curve);
    const u = clamp(finite(p, 0), 0, 1);
    if (!c) return u;
    const a = c.accel / 100, d = c.decel / 100;
    const x1 = a < 0 ? 0.5 * -a : 0, y1 = a > 0 ? Math.min(1, 0.5 * a) : 0;
    const x2 = d < 0 ? 1 - 0.5 * -d : 1, y2 = (d > 0 ? 1 - Math.min(1, 0.5 * d) : 1) + c.overshoot / 100;
    if (!x1 && !y1 && x2 === 1 && y2 === 1) return u;
    return cubicBezierY(x1, y1, x2, y2, u);
  };

  /* 点の列（poly）。path = { kind:"poly", points:[{u,v,hM, dwellSec?, moveSec?, curve?}...], mode:"loop"|"bounce"|"once", moveSec?, dwellSec?, curve? }
     区間＝{from,to,moveMs,dwellMs}。到着してから dwell。moveSec 0 は「跳ぶ」。 */
  const POLY_MODES = ["loop", "bounce", "once"];
  const polyPoints = (path) => (path && Array.isArray(path.points) ? path.points.filter((p) => p && typeof p === "object") : []);
  const polyTraversal = (path) => {
    const pts = polyPoints(path);
    const mode = path && POLY_MODES.includes(path.mode) ? path.mode : "loop";
    if (pts.length < 2) return { pts, segs: [], cycleMs: 1000, mode };
    const n = pts.length, order = [];
    if (mode === "loop") for (let i = 0; i < n; i += 1) order.push([i, (i + 1) % n]);
    else if (mode === "bounce") { for (let i = 0; i < n - 1; i += 1) order.push([i, i + 1]); for (let i = n - 1; i > 0; i -= 1) order.push([i, i - 1]); }
    else for (let i = 0; i < n - 1; i += 1) order.push([i, i + 1]);
    const segs = order.map(([from, to]) => ({
      from, to,
      moveMs: clamp(finite(pts[to].moveSec, finite(path.moveSec, 1)), 0, 600) * 1000,
      dwellMs: clamp(finite(pts[to].dwellSec, finite(path.dwellSec, 0)), 0, 600) * 1000,
      curve: pts[to].curve !== undefined ? pts[to].curve : path.curve,
    }));
    const cycleMs = Math.max(200, segs.reduce((sum, g) => sum + g.moveMs + g.dwellMs, 0));
    return { pts, segs, cycleMs, mode };
  };
  const polyCycleMs = (path) => polyTraversal(path).cycleMs;
  const polyAt = (rawPath, t, mirror, dims) => {
    /* 組の鏡映は「点の並びを逆にして同じ時間で回る」＝往復の鏡映（端を入れ替え）と同じ意味。
       時間を逆再生にはしない（2点の列だと同じ場所を同じ向きに通ってしまう）。 */
    const path = mirror ? { ...rawPath, points: polyPoints(rawPath).slice().reverse() } : rawPath;
    const { pts, segs, cycleMs, mode } = polyTraversal(path);
    if (!pts.length) return { ...pointWorld(newPoint(), dims), phase: 0 };
    if (!segs.length) return { ...pointWorld(pts[0], dims), phase: 0 };
    const f = mode === "once" ? clamp(t, 0, 1) : saw(t);
    const shapeOf = (seg) => (u) => (seg.curve !== undefined && seg.curve !== null)
      ? curveMap(u, seg.curve)
      : ((path.easing || "ease") === "ease" ? 0.5 - Math.cos(u * Math.PI) / 2 : u);
    const at = f * cycleMs;
    let acc = 0;
    for (const seg of segs) {
      if (at < acc + seg.moveMs) {
        const u = seg.moveMs > 0 ? (at - acc) / seg.moveMs : 1;
        const a = pointWorld(pts[seg.from], dims), b = pointWorld(pts[seg.to], dims), sMix = shapeOf(seg)(u);
        return { x: a.x + (b.x - a.x) * sMix, y: a.y + (b.y - a.y) * sMix, z: a.z + (b.z - a.z) * sMix, phase: f };
      }
      acc += seg.moveMs;
      if (at < acc + seg.dwellMs) return { ...pointWorld(pts[seg.to], dims), phase: f };
      acc += seg.dwellMs;
    }
    return { ...pointWorld(pts[segs[segs.length - 1].to], dims), phase: f };
  };

  /* 組の効果を位相へ反映する。
   *   together … 全員同じ位相／sequential … メンバー順にdelayMsずつ遅らせる
   *   mirror   … 先頭以外は軌道を鏡映（line: 端を入れ替え／circle: 回転を反転・中心は保持）
   */
  const groupEffect = (cue, fixtureId) => {
    const g = (cue.groups || []).find((x) => x.members.includes(fixtureId));
    if (!g) return { phaseShiftMs: 0, mirror: false };
    const idx = g.members.indexOf(fixtureId);
    if (g.relation === "sequential") return { phaseShiftMs: -idx * finite(g.delayMs, 400), mirror: false };
    if (g.relation === "mirror") return { phaseShiftMs: 0, mirror: idx % 2 === 1 };
    return { phaseShiftMs: 0, mirror: false };
  };

  // Point3 → 世界座標（この一本だけで床・奥壁・空中すべてを扱う。2026-09-11 第3ラウンドで統一）
  const pointWorld = (p, dims) => {
    if (p && p.coordinateMode === "legacy-panel") {
      return { x: (finite(p.u, 0.5) - 0.5) * dims.W, y: finite(p.v, 0.5) * dims.D, z: finite(p.hM, 0) };
    }
    return {
      x: (clamp(finite(p && p.u, 0.5), 0, 1) - 0.5) * dims.W,
      // aheadM を持つ点（客席へ向けた狙い点）だけ舞台の外(y > D)へ出る。持たない点は従来どおり舞台の中
      y: clamp(finite(p && p.v, 0.5), 0, 1) * dims.D + clamp(finite(p && p.aheadM, 0), 0, HOUSE_AHEAD_MAX),
      z: clamp(finite(p && p.hM, 0), 0, dims.H),
    };
  };

  // 軌道面ごとの円周上オフセット（世界座標のdx,dy,dz）
  /* 円・8の字は「その面の中の2軸」で作る。r＝1軸目、r2＝2軸目（省くと真円）、tilt＝面の中での傾き（度）。
     軸の向きは面ごとに決まる: 水平＝1軸目が左右・2軸目が奥行き／客席側から見た縦＝左右・高さ／
     舞台横から見た縦＝奥行き・高さ。2026-09-11 本人要望で楕円・傾き・8の字を追加。 */
  const planeVec = (plane, a, b, tiltDeg) => {
    const th = (finite(tiltDeg, 0) * Math.PI) / 180;
    if (th) { const c = Math.cos(th), sn = Math.sin(th); const a2 = a * c - b * sn; b = a * sn + b * c; a = a2; }
    if (plane === "frontVertical") return { dx: a, dy: 0, dz: b };   // 客席側から見た縦
    if (plane === "sideVertical") return { dx: 0, dy: a, dz: b };    // 舞台横から見た縦
    return { dx: a, dy: b, dz: 0 };                                  // 水平（既定）
  };
  const circleOffset = (plane, ang, r, r2, tiltDeg) =>
    planeVec(plane, Math.cos(ang) * r, Math.sin(ang) * (r2 == null ? r : r2), tiltDeg);
  /* 8の字（ジェロノのレムニスケート）。1軸目が sin、2軸目が sin(2θ)。
     θが一周する間に2軸目が2往復するので、横長の∞を描く。 */
  const eightOffset = (plane, ang, r, r2, tiltDeg) =>
    planeVec(plane, Math.sin(ang) * r, Math.sin(ang * 2) * (r2 == null ? r : r2), tiltDeg);

  /* 周期の中の「いま」。0〜1が周期1回ぶん。組の順番送りと一灯ずつのオフセットを織り込む。
     一灯ずつの遅らせ（オフセット秒）は組の順番送りとは別に持てるので、
     組にしていない灯どうしでも波をずらせる（2026-09-12 本人要望）。 */
  const cycleT = (light, cue, fixtureId, tMs) => {
    const { phaseShiftMs, mirror } = groupEffect(cue, fixtureId);
    const offsetMs = clamp(finite(light.offsetSec, 0), -60, 60) * 1000;
    return { t: (tMs + phaseShiftMs - offsetMs) / periodMs(light), mirror };
  };
  /* 往復の位相（0＝A側・1＝B側）。位置の往復と、広がり・強さの往復が同じ式を使う。
     往復の運び方（2026-09-11 本人要望）:
       "linear"＝端で急に折り返す機械的な動き。卓のフェードをそのまま当てた感じ。
       "ease"（既定）＝端で減速して止まり、また加速する。ムービングのヨークは
       止まる前に減速するので、実物はこちらに近い。式は cos の半周期（ease-in-out）。 */
  /* 運び方: path.curve（加速・減速の2数値、または既定名）があればそれ、無ければ従来の easing。 */
  const swingShape = (path) => (u) => (path.curve !== undefined && path.curve !== null)
    ? curveMap(u, path.curve)
    : ((path.easing || "ease") === "ease" ? 0.5 - Math.cos(u * Math.PI) / 2 : u);
  const swingPhase = (light, t, mirror) => {
    const path = light.path || {};
    const shape = swingShape(path);
    /* 端で止まる（grandMA3 の Width と Transition＝1段のうち動く割合を「止まる秒」で持つ）。
       1往復＝A→B・Bで止まる・B→A・Aで止まる。periodSec はその合計のまま。 */
    const dw = path.dwell && typeof path.dwell === "object" ? path.dwell : null;
    const dA = dw ? clamp(finite(dw.a, 0), 0, 600) : 0, dB = dw ? clamp(finite(dw.b, 0), 0, 600) : 0;
    let p;
    if (path.kind === "line" && (dA > 0 || dB > 0)) {
      const T = periodMs(light) / 1000;
      const fa = clamp(dA / T, 0, 0.45), fb = clamp(dB / T, 0, 0.45), m = Math.max(0.05, (1 - fa - fb) / 2);
      const f = saw(t);
      if (f < m) p = shape(f / m);
      else if (f < m + fb) p = 1;
      else if (f < 2 * m + fb) p = 1 - shape((f - m - fb) / m);
      else p = 0;
    } else p = shape(tri(t));
    if (path.kind === "line" && path.start === "b") p = 1 - p;
    if (mirror) p = 1 - p;
    return p;
  };
  /* 広がり・強さが「動きの中で変わる」ときの位相（0＝始めの値・1＝終わりの値）。
     往復（line）は位置とまったく同じ位相＝Aで始めの値、Bで終わりの値になる。
     円・8の字・動きなしは、1周（1周期）で 始め→終わり→始め と往復させる（2026-09-13）。 */
  const paramPhase = (light, cue, fixtureId, tMs) => {
    if (!light) return 0;
    const { t, mirror } = cycleT(light, cue, fixtureId, tMs);
    return swingPhase(light, t, mirror);
  };
  /* 時刻 tMs における広がり（°）と強さ（0〜100）。終わりの値を持たない灯はそのままの値。 */
  const beamDegAt = (fixture, light, phase) => {
    const base = beamDegOf(fixture, light);
    if (!isMoving(fixture) || !light || light.beamDegTo == null) return base;
    return base + (clamp(finite(light.beamDegTo, base), 4, 70) - base) * clamp(finite(phase, 0), 0, 1);
  };
  const levelAt = (light, phase) => {
    const base = levelOf(light);
    if (!light || light.levelTo == null) return base;
    return base + (clamp(finite(light.levelTo, base), 0, 100) - base) * clamp(finite(phase, 0), 0, 1);
  };
  /* 色（第6弾・2026-09-27）。終わりの色 colorTo を持つ灯は、強さ・広がりと同じ位相で始めの色から終わりの色へ混ざる。
     無い・不正・同じ色ならそのまま。描画側は l.color を直読みせず colorAt を通す（app.js の描画約20か所）。 */
  const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
  const colorAt = (light, phase, fixture) => {
    const base = light && HEX_COLOR_RE.test(String(light.color)) ? light.color : "#f2ead6";
    if (!light || !HEX_COLOR_RE.test(String(light.colorTo)) || String(light.colorTo).toLowerCase() === base.toLowerCase()) return base;
    const p = clamp(finite(phase, 0), 0, 1);
    if (colorSnaps(fixture)) return p < 0.5 ? base : light.colorTo;   // カラーホイール: 半分で一瞬
    return mixHex(base, light.colorTo, p);
  };

  /* ストロボ（ムービングの光の強さに載せる、時間で繰り返す点滅）。2026-09-13 本人要望。
     始点・終点の往復（levelAt）とは別枠——強さの「値」ではなく「その瞬間どれだけ削るか」の
     掛け算にして、上に載せるだけで足す（往復のどの位置でも同じように点滅する）。
       light.strobe = { on, kind:"sharp"|"soft", hz(0.5〜20), duty(5〜95, sharp用), depth(0〜100, soft用), phaseNorm(0〜1) }
     kind="sharp"（くっきり）＝矩形波。1周期のうち duty% だけ全開、残りは真っ暗——「パパパッ」。
     kind="soft"（やわらかい）＝なめらかな明滅（1−cos）。0では全開のまま、100で完全に沈む
     ところまで——「ちょっとフェード寄り」。
     tMs は絶対時刻でよい（周期で割った余りしか使わない＝どこから再生しても同じ位相になる）。

     順送り（2026-09-17）: strobe.seq があれば「複数灯を順に光らせる」評価に切り替える。
     4層モデル（属性×波形×時間×並び）の「強さ×矩形」の1インスタンスで、第2弾で fx 配列へ持ち上げる前提。
       strobe.seq = { count(段数), rank(この灯の段 0..count-1), width(同時に光る段数 | "build"),
                      direction:"fwd"|"rev"|"bounce"|"random", loops(0=ずっと), after:"off"|"hold",
                      flashes(1段あたりの点滅回数), floor(消えている間の強さ %), seed }
     hz は「1秒に進む段数」。1段＝1000/hz ms。1周＝count 段（bounce は 2*count-2 段）。
     loops>0 なら再生開始（tMs=0）から loops 周で止まる。seq が無い旧データは従来どおり。 */
  const seqHash = (seed, salt) => (Math.imul((seed >>> 0) ^ 0x9e3779b9, 2654435761) + Math.imul(salt + 1, 2246822519)) >>> 0;
  const seqRand = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
  const seqPermutation = (count, seed, cycleIndex) => {
    const rng = seqRand(seqHash(seed, cycleIndex));
    const arr = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
    return arr;
  };
  const rand01 = (seed, index) => seqHash(finite(seed, 1) >>> 0, index) / 4294967296;
  /* 強さの形（2026-09-17 本人要望で くっきり／やわらかい に5つ追加）。
     phase は 0〜1。順送りでは「その灯の持ち時間」の中の位置になる。
     ちらつき・稲妻だけは phase ではなく<b>絶対時刻</b>から作る——周期にきっちり乗せると
     同じ揺れが繰り返して作り物に見えるため。seed が同じなら同じ揺れを再現する。
       くっきり sharp     … 矩形。duty% のあいだ全開（従来）
       やわらかい soft     … 1−cos のなめらかな明滅（従来）
       だんだん明るく rampUp / だんだん暗く rampDown … のこぎり。1周期で一方向
       ちらつき flicker    … 炎・ろうそく。なめらかな乱数で浅く揺れる
       稲妻 lightning      … ふだん暗く、たまに短く強い閃光（1周期に1〜2回）
       鼓動 heartbeat      … ドッ・ドッ…（間）の二連
     知らない名前は くっきり として扱う（古いデータ・未知の値でも壊れない）。 */
  const strobeWave = (strobe, phase, t, hz) => {
    const kind = strobe && strobe.kind;
    const depth = clamp(finite(strobe && strobe.depth, 60), 0, 100) / 100;
    const seed = strobe && strobe.seed;
    if (kind === "soft") return 1 - depth * (1 - Math.cos(phase * 2 * Math.PI)) / 2;
    if (kind === "rampUp") return 1 - depth * (1 - phase);
    if (kind === "rampDown") return 1 - depth * phase;
    if (kind === "flicker") {
      const sliceMs = Math.max(20, 1000 / Math.max(0.1, hz * 4));
      const index = Math.floor(t / sliceMs), fr = t / sliceMs - index;
      const a = rand01(seed, index), b = rand01(seed, index + 1);
      const ease = fr * fr * (3 - 2 * fr);
      return 1 - depth * (1 - (a + (b - a) * ease));
    }
    if (kind === "lightning") {
      const period = 1000 / Math.max(0.1, hz);
      const cycle = Math.floor(t / period), p = ((t % period) + period) % period / period;
      const start = rand01(seed, cycle * 3) * 0.7;
      const len = 0.03 + rand01(seed, cycle * 3 + 1) * 0.05;
      let on = p >= start && p < start + len;
      if (!on && rand01(seed, cycle * 3 + 2) > 0.45) {
        const second = start + len + 0.05;
        on = p >= second && p < second + len * 0.6;
      }
      return on ? 1 : 1 - depth;
    }
    if (kind === "heartbeat") {
      const peak = (center, width) => Math.max(0, 1 - Math.abs(phase - center) / width);
      return 1 - depth * (1 - Math.max(peak(0.07, 0.07), peak(0.26, 0.06) * 0.85));
    }
    if (kind === "random" || kind === "randomPulse") {
      /* 間隔がランダムな点滅（GDTF StrobeModeRandom／RandomPulse）。hz は平均の回数。
         1回ぶんの枠の中で発光の位置を乱数で決め、たまに1回抜く。同じ seed なら同じ並び。 */
      const slot = 1000 / Math.max(0.1, hz);
      const k = Math.floor(t / slot), u = t / slot - k;
      const duty = clamp(finite(strobe && strobe.duty, 50), 5, 95) / 100;
      const skip = rand01(seed, k * 3 + 2) > 0.85;
      const start = rand01(seed, k * 3) * (1 - duty);
      const inFlash = !skip && u >= start && u < start + duty;
      if (kind === "random") return inFlash ? 1 : 0;
      return (1 - depth) + (inFlash ? depth * Math.sin(((u - start) / duty) * Math.PI) : 0);
    }
    const duty = clamp(finite(strobe && strobe.duty, 50), 5, 95) / 100;
    return phase < duty ? 1 : 0;
  };
  const seqMul = (strobe, t) => {
    const seq = strobe.seq;
    const hz = clamp(finite(strobe.hz, 2), 0.1, 20);
    const stepMs = 1000 / hz;
    const count = Math.max(1, Math.round(finite(seq.count, 1)));
    const rank = clamp(Math.round(finite(seq.rank, 0)), 0, count - 1);
    const floor = clamp(finite(seq.floor, 0), 0, 100) / 100;
    const direction = ["fwd", "rev", "bounce", "random"].includes(seq.direction) ? seq.direction : "fwd";
    const steps = direction === "bounce" ? Math.max(1, 2 * count - 2) : count;
    const cycleMs = steps * stepMs;
    const shifted = Math.max(0, t) + clamp(finite(strobe.phaseNorm, 0), 0, 1) * cycleMs;
    const cycleIndex = Math.floor(shifted / cycleMs);
    const loops = Math.max(0, Math.round(finite(seq.loops, 0)));
    const ended = loops > 0 && cycleIndex >= loops;
    const evalCycle = ended ? loops - 1 : cycleIndex;
    const inCycle = ended ? cycleMs - 1e-6 : ((shifted % cycleMs) + cycleMs) % cycleMs;
    const step = Math.min(steps - 1, Math.floor(inCycle / stepMs));
    const perm = direction === "random" ? seqPermutation(count, finite(seq.seed, 1), evalCycle) : null;
    const activeRank = (s) => {
      if (direction === "rev") return count - 1 - s;
      if (direction === "bounce") return s < count ? s : 2 * count - 2 - s;
      if (direction === "random") return perm[s];
      return s;
    };
    const build = seq.width === "build";
    const lookback = build ? step : clamp(Math.round(finite(seq.width, 1)), 1, steps) - 1;
    let active = false;
    for (let k = 0; k <= lookback && !active; k += 1) {
      let s = step - k;
      if (s < 0) { if (build) break; s += steps; }
      if (activeRank(s) === rank) active = true;
    }
    if (!active) return floor;
    if (ended) return seq.after === "hold" ? 1 : floor;
    const flashes = clamp(Math.round(finite(seq.flashes, 1)), 1, 8);
    const sub = (inCycle - step * stepMs) / stepMs;
    const fr = ((sub * flashes) % 1 + 1) % 1;
    return Math.max(floor, strobeWave(strobe, fr, t, hz));
  };
  const strobeMul = (strobe, tMs) => {
    if (!strobe || !strobe.on) return 1;
    if (strobe.seq && typeof strobe.seq === "object") return seqMul(strobe, finite(tMs, 0));
    const hz = clamp(finite(strobe.hz, 6), 0.3, 20);
    const period = 1000 / hz;
    const t = finite(tMs, 0);
    /* 実機の「スパイク」（発光の間も薄く点いたまま）と「ブラインダー」（一回点けて保持）。
       floor＝消えている間の底（%）、loops＝周数（0=ずっと）、after＝周数を終えたあと off/hold。
       順送り（seq）と同じ鍵名・同じ意味。 */
    const floor = clamp(finite(strobe.floor, 0), 0, 100) / 100;
    const loops = Math.max(0, Math.round(finite(strobe.loops, 0)));
    if (loops > 0 && Math.floor(Math.max(0, t) / period) >= loops) return strobe.after === "hold" ? 1 : floor;
    const phase = ((((t % period) + period) % period) / period + clamp(finite(strobe.phaseNorm, 0), 0, 1)) % 1;
    return Math.max(floor, strobeWave(strobe, phase, t, hz));
  };

  /* 時刻 tMs における光の当たる先（世界座標）。未設定・消灯は null。 */
  const targetAt = (light, cue, fixtureId, tMs, dims = DEFAULT_DIMS) => {
    if (!light || light.on !== true) return null;
    const path = light.path || { kind: "still", a: newPoint() };
    const { t, mirror } = cycleT(light, cue, fixtureId, tMs);
    if (path.kind === "line") {
      const p = swingPhase(light, t, mirror);
      const a = pointWorld(path.a, dims), b = pointWorld(path.b, dims);
      return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p, z: a.z + (b.z - a.z) * p, phase: p };
    }
    if (path.kind === "circle" || path.kind === "eight") {
      const c = pointWorld(path.c, dims);
      const lim = Math.max(dims.W, dims.D, dims.H);
      const r = clamp(finite(path.r, 1.5), 0.2, lim);
      const r2 = path.r2 == null ? r : clamp(finite(path.r2, r), 0.2, lim);
      let ang = saw(t + finite(path.start, 0)) * Math.PI * 2;
      if (path.dir === "ccw") ang = -ang;
      if (mirror) ang = Math.PI - ang;
      const o = (path.kind === "eight" ? eightOffset : circleOffset)(path.plane, ang, r, r2, path.tilt);
      return { x: c.x + o.dx, y: clamp(c.y + o.dy, 0, dims.D + HOUSE_AHEAD_MAX), z: clamp(c.z + o.dz, 0, dims.H), phase: saw(t) };
    }
    if (path.kind === "poly") return polyAt(path, t, mirror, dims);
    return { ...pointWorld(path.a, dims), phase: 0 };
  };

  /* 軌道の目安（破線用）。時刻に依存しない。 */
  const pathGuide = (light, dims = DEFAULT_DIMS) => {
    if (!light) return null;
    const path = light.path;
    if (!path || path.kind === "still") return null;
    if (path.kind === "line") return { kind: "line", a: pointWorld(path.a, dims), b: pointWorld(path.b, dims) };
    /* 円・8の字の下書きは、傾きも8の字も一度に扱えるよう「世界座標の点の並び」で返す。
       図の側は面を見て、線でつなぐだけでよくなる。 */
    if (path.kind === "circle" || path.kind === "eight") {
      const c = pointWorld(path.c, dims);
      const r = clamp(finite(path.r, 1.5), 0.2, 20);
      const r2 = path.r2 == null ? r : clamp(finite(path.r2, r), 0.2, 20);
      const off = path.kind === "eight" ? eightOffset : circleOffset;
      const N = 64, pts = [];
      for (let i = 0; i <= N; i++) {
        const o = off(path.plane, (i / N) * Math.PI * 2, r, r2, path.tilt);
        pts.push({ x: c.x + o.dx, y: c.y + o.dy, z: c.z + o.dz });
      }
      return { kind: "loop", shape: path.kind, c, r, r2, tilt: finite(path.tilt, 0), plane: path.plane || "horizontal", pts };
    }
    if (path.kind === "poly") {
      const raw = polyPoints(path);
      if (raw.length < 2) return null;
      const pts = raw.map((p) => pointWorld(p, dims));
      const mode = POLY_MODES.includes(path.mode) ? path.mode : "loop";
      if (mode === "loop") pts.push(pts[0]);
      return { kind: "loop", shape: "poly", mode, pts, c: pts[0] };
    }
    return null;
  };

  /* ---------- 投影 ----------
   * plan: 上から。x→右、y(奥行き)→下／ front: 客席から。x→右、z→上
   * side: 舞台中央からその側（下手/上手）を見る。横軸＝奥行き、縦軸＝高さ
   */
  const makePlanProjector = (dims, box) => {
    const sx = box.w / dims.W, sy = box.h / dims.D;
    return (p) => ({ X: box.x + (p.x + dims.W / 2) * sx, Y: box.y + p.y * sy });
  };
  const makeFrontProjector = (dims, box) => {
    const sx = box.w / dims.W, sz = box.h / dims.H;
    return (p) => ({ X: box.x + (p.x + dims.W / 2) * sx, Y: box.y + box.h - p.z * sz });
  };
  const makeSideProjector = (dims, box, side) => {
    const sz = box.h / dims.H;
    return (p) => {
      const t = p.y / dims.D;
      const X = box.x + (side === "shimote" ? (1 - t) : t) * box.w;
      return { X, Y: box.y + box.h - p.z * sz };
    };
  };
  const sideToVH = (dims, box, side, X, Y) => {
    const t = clamp((X - box.x) / box.w, 0, 1);
    return { v: side === "shimote" ? 1 - t : t, h: clamp((box.y + box.h - Y) / box.h * dims.H, 0, dims.H) };
  };
  // 逆投影（平面図・正面図のクリック→u,v／u,高さ）
  const planToUV = (dims, box, X, Y) => ({ u: clamp((X - box.x) / box.w, 0, 1), v: clamp((Y - box.y) / box.h, 0, 1) });
  const frontToUH = (dims, box, X, Y) => ({ u: clamp((X - box.x) / box.w, 0, 1), h: clamp((box.y + box.h - Y) / box.h * dims.H, 0, dims.H) });

  /* ---------- 説明文（照明さんへ渡す一行） ---------- */

  /* ---------- 正面図の3D（擬似パース） ----------
     舞台スケッチ本体（stage-sketch.js の place / perMetre / stagePoint）と同じ式。
     席ごとの数値（floorY/bottomY/backW/frontW/rise）は stage-venues.js の値をそのまま使う。
     本体は720pxの絵を基準に作ってあるので、枠の高さで比例させる（本体の k = H/BASE_H と同じ）。
     首振り（tilt）と横席のずれ（shift）は試作では使わないので入れていない。 */
  const FRONT_BASE_H = 720;
  const FRONT_SEATS = {
    /* 1階 中央（2026-09-13 修正: 後方より高く見えて前後が逆だという本人指摘）。
       幅の比 frontW/backW=1.88 は舞台前端まで約9.1mを意味する。元の帯 120（478→598）では
       目線が床から約3.0mで、後方（2.5m）より高く＝客席の傾斜と逆になっていた。
       実際は 舞台の高さ約1m・9mぶんの傾斜で0.8〜1.5m上がる・座った目線1.15m から
       <b>舞台の床より約1.2m上</b>。帯を 120→48 にした（見下ろす角度 約7.5度）。
       これで 前方0.4m → 中央1.2m → 後方2.5m と、後ろの席ほど高くなる並びにそろう。 */
    center: { id: "center", label: "1階 中央", floorY: 478, bottomY: 526, backW: 0.5, frontW: 0.94, rise: 0.06 },
    /* 1階 後方（2026-09-13 修正: 2階席のように見えるという本人指摘）。
       床の帯（bottomY - floorY）は「目線が舞台の床からどれだけ高いか」を決める。
       幅の比 frontW/backW=1.52 は 舞台前端まで約15m（奥行き8mなら 15.4m）を意味し、これは後方席として妥当。
       その距離で床の帯／奥の壁の高さ を測ると、元の 204（470→674）は目線が床から約7.1m＝2階席の高さだった
       （実測: 床の帯168px ÷ 奥の壁366px ÷ ((1.52-1)/8) ≒ 7.1m）。
       1階後方の実際は、舞台の高さ約1m・客席の傾斜で約2.5〜3.5m上がる・座った目線1.15m から
       <b>舞台の床より約2.5m上</b>。その比に合わせて帯を 204→72 にした（見下ろす角度 約9.5度）。
       floorY は変えていないので、奥の壁の大きさと幅の比はそのまま。床より下は客席側の暗がりが広がる。 */
    rear: { id: "rear", label: "1階 後方", floorY: 470, bottomY: 542, backW: 0.62, frontW: 0.94, rise: 0 },
    front: { id: "front", label: "1階 前方", floorY: 490, bottomY: 532, backW: 0.45, frontW: 1.75, rise: 0.15 },
    /* 2階席（2026-09-13 本人要望で追加）。1階の3席と同じ考え方で数値を決める。
       中規模ホールの2階前方はおおむね 舞台前端まで約18m・舞台の床より約7.5m上（見下ろし約23度）。
       幅の比 frontW/backW = 1 + 8/18 ≒ 1.45。frontW は他の席と同じ0.94にそろえ backW=0.65。
       床の帯は 266（製品の392→658）だと目線が約13.1m＝見下ろし36度で、ホールの2階にしては高すぎた
       （実測）。7.5m になるよう 266→152（bottomY 658→544）へ詰めた。rise は手前ほど背を低く見せる負の値。
       製品 stage-venues.js の balcony は floorY392/bottomY658/backW0.5/frontW0.9 だが、
       その幅の比は前端まで10mを意味し eye:18 と食い違うので、ここでは比のほうを実距離に合わせた。 */
    balcony: { id: "balcony", label: "2階席", floorY: 392, bottomY: 544, backW: 0.65, frontW: 0.94, rise: -0.12 },
  };
  const frontPerspSetup = (dims, box, seatId) => {
    const seat = FRONT_SEATS[seatId] || FRONT_SEATS.center;
    const k = box.h / FRONT_BASE_H;
    const floorY = box.y + seat.floorY * k;
    const bottomY = box.y + seat.bottomY * k;
    const span = seat.frontW / seat.backW;                 // 手前は奥の何倍に見えるか
    const headroom = Math.max(24, floorY - box.y - 22);    // 奥の壁の上に残す余白
    const pxPerM = Math.min((box.w * seat.frontW) / dims.W, headroom / ((dims.H || 8) / span));
    const frontW = pxPerM * dims.W;
    return { seat, floorY, bottomY, pxPerM, frontW, backW: frontW / span, centerX: box.x + box.w / 2, span };
  };
  // world {x,y,z} → 画面。scale は「その奥行きでの縮み」。灯体の印の大きさにも使える
  const makeFrontPerspProjector = (dims, box, seatId) => {
    const L = frontPerspSetup(dims, box, seatId);
    return (p) => {
      const u = p.x / dims.W + 0.5, v = finite(p.y, 0) / dims.D;
      const rawY = L.floorY + v * (L.bottomY - L.floorY);
      const halfW = (L.backW + v * (L.frontW - L.backW)) / 2;
      const scale = (L.backW + v * (L.frontW - L.backW)) / L.frontW;
      const stretch = 1 + L.seat.rise * v;
      return { X: L.centerX + (u - 0.5) * halfW * 2, Y: rawY - finite(p.z, 0) * L.pxPerM * scale * stretch, scale };
    };
  };
  /* 画面 → 左右uと高さh。奥行き v は分からないので呼び手が渡す（動かしている点の v をそのまま使う）。
     本体の fromScreen と同じ考え方で、v を決めてから逆算する。 */
  const frontPerspToUH = (dims, box, seatId, X, Y, v) => {
    const L = frontPerspSetup(dims, box, seatId);
    const vv = clamp(finite(v, 0.5), 0, 1);
    const rawY = L.floorY + vv * (L.bottomY - L.floorY);
    const halfW = (L.backW + vv * (L.frontW - L.backW)) / 2;
    const scale = (L.backW + vv * (L.frontW - L.backW)) / L.frontW;
    const stretch = 1 + L.seat.rise * vv;
    return {
      u: clamp((X - L.centerX) / (halfW * 2) + 0.5, 0, 1),
      h: clamp((rawY - Y) / (L.pxPerM * scale * stretch), 0, dims.H),
    };
  };

  /* ---------- 正面図の遠方カメラ ----------
     通常の正面図は、舞台前方200mの中央から舞台中心を見たときの控えめな透視投影。
     座標や保存値を変えず、表示だけで奥の物ほどわずかに小さくする。舞台の奥行きが
     8mなら前後差は約4%なので、作図として読めるまま実際の見え方に寄せられる。 */
  const FRONT_FAR_CAMERA_M = 200;
  const frontFarSetup = (dims, box, distanceM = FRONT_FAR_CAMERA_M) => {
    const distance = Math.max(1, finite(distanceM, FRONT_FAR_CAMERA_M));
    const pxPerM = Math.min((box.w / dims.W) * 0.96, (box.h / dims.H) * 0.96);
    return { distance, pxPerM, centerX: box.x + box.w / 2, centerY: box.y + box.h / 2, eyeZ: dims.H / 2 };
  };
  const makeFrontFarProjector = (dims, box, distanceM = FRONT_FAR_CAMERA_M) => {
    const L = frontFarSetup(dims, box, distanceM);
    return (p) => {
      const y = finite(p && p.y, 0), depth = Math.max(1e-6, L.distance + dims.D - y);
      const scale = L.distance / depth;
      return {
        X: L.centerX + finite(p && p.x, 0) * L.pxPerM * scale,
        Y: L.centerY + (L.eyeZ - finite(p && p.z, 0)) * L.pxPerM * scale,
        scale,
      };
    };
  };
  const frontFarToUH = (dims, box, X, Y, v, distanceM = FRONT_FAR_CAMERA_M) => {
    const L = frontFarSetup(dims, box, distanceM);
    const vv = clamp(finite(v, 0.5), 0, 1), y = vv * dims.D;
    const scale = L.distance / Math.max(1e-6, L.distance + dims.D - y);
    return {
      u: clamp((X - L.centerX) / (L.pxPerM * scale) / dims.W + 0.5, 0, 1),
      h: clamp(L.eyeZ - (Y - L.centerY) / (L.pxPerM * scale), 0, dims.H),
    };
  };

  const describeMount = (fixture, rig) => {
    const m = fixture.mount || {};
    const mm = (metres) => `${Math.round(finite(metres, 0) * 1000)}mm`;
    const lr = (u) => (u < 0.4 ? "下手寄り" : u > 0.6 ? "上手寄り" : "中央");
    if (m.type === "truss") {
      const t = trussById(rig, m.trussId);
      const row = trussRow(rig, m.trussId);
      return t ? `吊り・奥から${row}列目のバトン（高さ約${mm(t.h)}）・${lr(m.u)}` : "吊り（バトン不明）";
    }
    if(m.type === "position"){const p=root.GAMMA_LIGHT_MODEL?.positionNames?.record(rig,m.positionId);return p?`${root.GAMMA_LIGHT_MODEL.positionNames.caption(p)}・区間内${Math.round(m.t*100)}%`:"設置区間（参照先不明）";}
    if (m.type === "floor") return `転がし・${lr(m.u)}・${m.v < 0.4 ? "奥" : m.v > 0.6 ? "手前" : "中ほど"}`;
    if (m.type === "front") return `前明かり・${lr(m.u)}・舞台前から約${mm(finite(m.ahead, 5))}・高さ約${mm(finite(m.h, 7))}`;
    if (m.type === "side") return `SS・${m.side === "shimote" ? "下手" : "上手"}の袖（高さ約${mm(m.h)}）・${m.v < 0.4 ? "奥寄り" : m.v > 0.6 ? "手前寄り" : "中ほど"}`;
    if (m.type === "cyc") return `ホリゾントライト（${m.rung === "top" ? "上" : "床"}）・舞台幅100%`;
    if (m.type === "legacy-panel") {
      if (![m.u, m.v, m.h].every(Number.isFinite)) return "旧ベータの照明位置（未設定）";
      return `旧ベータの照明位置・${lr(m.u)}・${m.v < 0.4 ? "奥" : m.v > 0.6 ? "手前" : "中ほど"}・高さ約${mm(m.h)}`;
    }
    return "取り付け未設定";
  };

  /* 一覧の行に出す短い位置の言葉（2026-09-13 本人要望で復帰）。
     見出し側がすでに「吊り・奥から1列目」「SS・下手の袖」などを言っているので、
     行では<b>その中で灯ごとに違うところだけ</b>を返す。 */
  const mountSpot = (fixture) => {
    const m = (fixture && fixture.mount) || {};
    const lr = (u) => (u < 0.4 ? "下手寄り" : u > 0.6 ? "上手寄り" : "中央");
    const fb = (v) => (v < 0.4 ? "奥" : v > 0.6 ? "手前" : "中ほど");
    if(m.type === "position")return `区間内${Math.round(m.t*100)}%`;
    if (m.type === "truss" || m.type === "front") return lr(m.u);
    if (m.type === "floor") return `${lr(m.u)}・${fb(m.v)}`;
    if (m.type === "side") return m.v < 0.4 ? "奥寄り" : m.v > 0.6 ? "手前寄り" : "中ほど";
    if (m.type === "legacy-panel") return Number.isFinite(m.u) && Number.isFinite(m.v) ? `${lr(m.u)}・${fb(m.v)}` : "位置未設定";
    return "";
  };

  const posWord = (p) => (finite(p && p.aheadM, 0) > 0
    ? `${p.u < 0.4 ? "下手" : p.u > 0.6 ? "上手" : "中央"}・舞台前から約${Math.round(finite(p.aheadM, 0) * 1000)}mm${p.hM > 0.05 ? `・高さ約${Math.round(p.hM * 1000)}mm` : ""}`
    : `${p.u < 0.4 ? "下手" : p.u > 0.6 ? "上手" : "中央"}・奥から${(p.v * 100).toFixed(0)}%${p.hM > 0.05 ? `・高さ約${Math.round(p.hM * 1000)}mm` : ""}`);
  const PLANE_LABEL = { horizontal: "水平の円", frontVertical: "客席側から見た縦の円", sideVertical: "舞台横から見た縦の円" };

  /* 強さ（調光）。未設定の灯は 100 とみなす＝これまでの「点いていれば全開」と同じ見え方になる。
     0 は消灯と同じ扱い（2026-09-13 本人決定。フェードを扱えるように点灯/消灯の2択から連続値へ）。 */
  const levelOf = (light) => clamp(finite(light && light.level, 100), 0, 100);
  /* 実際に光っているか。on が true でも強さ0なら光らない＝図にも出さない。 */
  const isLit = (light) => Boolean(light) && light.on === true
    && Math.max(levelOf(light), light.levelTo == null ? 0 : clamp(finite(light.levelTo, 0), 0, 100)) > 0;

  /* ---------- ゴボ（模様） ----------
     2026-09-13 本人決定「案B」。実機に内蔵されている絵柄そのものは写せない（各社のデザイン＝著作物）ので、
     舞台照明で通っている<b>分類名</b>で自前の絵柄を持つ。分類の出典は Rosco のカタログ区分
     （Breakups／Foliage／Windows, Doors & Blinds／Abstract ほか。2026-09-13 閲覧）。
     枚数は調べた4機種（回転7〜9・固定10〜18: MAC Encore Two / MegaPointe / Sharpy Plus /
     PLUTO600 PROFILE MK2）の中央あたりに合わせ、回す前提のものを rot、回さないものを stat とした。
     絵柄は「丸い窓の中の、光が通るところ」を 0〜1 の座標で持つ。描く側はこれを拡大して使う。 */
  /* 渦巻きを「帯」の多角形にして返す（0〜1の座標）。外へ向かう縁をたどってから
     内側の縁を戻ることで、閉じた1本の帯になる——fill でも SVG の polygon でも同じに描ける。
     2026-09-13 本人指摘「同心円は存在しない。渦巻きに変える」。実機の spiral ゴボと同じ考え方。 */
  function spiralBand(turns, rMax, w, steps) {
    const out = [], inn = [], TAU = Math.PI * 2;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, a = t * TAU * turns, r = rMax * t;
      const co = Math.cos(a), si = Math.sin(a);
      out.push([0.5 + co * (r + w / 2), 0.5 + si * (r + w / 2)]);
      inn.push([0.5 + co * Math.max(r - w / 2, 0), 0.5 + si * Math.max(r - w / 2, 0)]);
    }
    return out.concat(inn.reverse());
  }
  /* ぎざぎざの不定形を撒く汎用の生成器。
     木漏れ日（フォリッジ）の参考画像から取り入れた性質（2026-09-13 本人提示。中身は写さず
     性質だけ取り入れた）をそのまま流用し、ブレイクアップ3種（粗・中・細）にも使う——
     実機のブレイクアップも木漏れ日も「不定形が敷き詰まった質感」という点では同じ作り方で
     足りる。違いは粒の大きさと数だけ（2026-09-13 本人指定「同じ生成器で作り直す」）。
       ・頂点ごとに半径と角度をばらした多角形にして、縁をとがらせる
       ・大きさはべき分布寄り（小さいものが多く、たまに大きい）
       ・一定の割合で既にある抜けのそばへ置く。nonzero で塗るので重なって塊になる
     opts:
       count   個数（多いほど白黒半々に近づく。下の呼び出しごとに実測して選んである）
       spread  円のどこまで撒くか（0〜0.5）
       cluster 新しい抜けを「既にある抜けの近く」に置く確率（0〜1）。高いほどつながって塊になる
       near    [最小距離, 距離の幅]。cluster で置くときの、近くの範囲
       min,range,pow  大きさ = min + rnd()^pow × range（pow を上げるほど小さいものに寄る）
       vmin,vrange    頂点の数（vmin 〜 vmin+vrange-1）
       jitter  頂点の角度のばらつき（大きいほど尖る）
       lo,hi   頂点ごとの半径のばらつき（lo 〜 lo+hi 倍）
     乱数は種を固定した自前の式——毎回まったく同じ形になる。 */
  function jaggedShapes(count, seed, opts) {
    const o = Object.assign({ spread: 0.47, cluster: 0.45, near: [0.012, 0.028],
      min: 0.007, range: 0.042, pow: 2.4, vmin: 7, vrange: 6, jitter: 0.75, lo: 0.35, hi: 1.3 }, opts);
    let x = seed >>> 0;
    const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
    const TAU = Math.PI * 2, out = [], seeds = [];
    for (let i = 0; i < count; i++) {
      let u, v;
      if (seeds.length && rnd() < o.cluster) {        // 既にある抜けの近くへ＝つながって塊になる
        const q = seeds[(rnd() * seeds.length) | 0];
        const a = rnd() * TAU, d = o.near[0] + rnd() * o.near[1];
        u = q[0] + Math.cos(a) * d; v = q[1] + Math.sin(a) * d;
      } else {                                       // 円のなかへ均等に撒く
        const a = rnd() * TAU, r = Math.sqrt(rnd()) * o.spread;
        u = 0.5 + Math.cos(a) * r; v = 0.5 + Math.sin(a) * r;
      }
      seeds.push([u, v]);
      const base = o.min + Math.pow(rnd(), o.pow) * o.range;   // 小さいものが多く、たまに大きい
      const n = o.vmin + Math.floor(rnd() * o.vrange), rot = rnd() * TAU, pts = [];
      for (let k = 0; k < n; k++) {
        const a = rot + (k / n) * TAU + (rnd() - 0.5) * o.jitter;   // 角度もばらす＝とがる
        const rr = base * (o.lo + rnd() * o.hi);
        pts.push([+(u + Math.cos(a) * rr).toFixed(3), +(v + Math.sin(a) * rr).toFixed(3)]);
      }
      out.push(["poly", pts]);
    }
    return out;
  }
  /* 木漏れ日はこの生成器の既定値（粒は細かい。実機の見本は直径の1/30ほどの粒から
     1/8ほどの塊まで混ざる）。白と黒がおよそ半々になる数（500個。実測50.0%）。
     ＊数や大きさを変えたら割合も変わる。半々を保ちたいときは測り直すこと。 */
  function foliageShapes(count, seed) { return jaggedShapes(count, seed, {}); }

  /* 格子窓・縦スリット（牢格子）は同じ構造——「窓の矩形をcols×rowsに割って、
     目地（gutter）ぶん痩せさせた矩形を敷き詰める」。違いは列数・行数・目地の太さだけ。
     実機のRosco写真を実測して決めた数値（2026-09-13 本人指摘で見直し。中身は写さず
     寸法比だけ測って使った）:
       Industrial Window（77279）: 8列×4行、窓は円の直径の70%×51%、目地は桝目の16%
       Jail Bars（77980）: 縦9列×4段、窓は44%×75%、縦の目地45%（太い鉄格子）・横の目地15%
     bw,bh＝窓の幅・高さ（円の直径=1に対する比）。gx,gy＝目地の太さ（桝目に対する比、0〜1）。 */
  function gridShapes(cols, rows, bw, bh, gx, gy) {
    const x0 = 0.5 - bw / 2, y0 = 0.5 - bh / 2, pitchX = bw / cols, pitchY = bh / rows;
    const cw = pitchX * (1 - gx), ch = pitchY * (1 - gy);
    const out = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      out.push(["rect", +(x0 + c * pitchX + (pitchX - cw) / 2).toFixed(4), +(y0 + r * pitchY + (pitchY - ch) / 2).toFixed(4),
        +cw.toFixed(4), +ch.toFixed(4)]);
    }
    return out;
  }
  /* 横スリット（ブラインド）は格子とは別の構造——薄いスラットが横一列に並び、
     縦方向は「細い脚・広い本体・細い脚」の3本の帯に分かれる（実機のRosco 77702を実測）。
     窓は46%×75%、スラット42本・目地45%（帯と帯の隙間がほぼ同じ太さ）。
     左右の脚は本体の約1/6の幅で、間に窓幅の6%ぶんの隙間がある。 */
  function blindShapes(slats, bw, bh, bandW, gapW, gy) {
    const x0 = 0.5 - bw / 2, y0 = 0.5 - bh / 2, pitchY = bh / slats, sh = pitchY * (1 - gy);
    const midW = bw - 2 * bandW - 2 * gapW;
    const bands = [[x0, bandW], [x0 + bandW + gapW, midW], [x0 + bw - bandW, bandW]];
    const out = [];
    for (let i = 0; i < slats; i++) {
      const y = y0 + i * pitchY + (pitchY - sh) / 2;
      bands.forEach(([bx, bwid]) => out.push(["rect", +bx.toFixed(4), +y.toFixed(4), +bwid.toFixed(4), +sh.toFixed(4)]));
    }
    return out;
  }
  /* 放射（ワゴンホイール）。実機のRosco Cart Spokes（78165）を実測すると、羽根は
     ハブから外周へ向けて幅が広がる台形で、まっすぐな棒ではなくハブに丸い抜きがある
     （実測: 13枚・ハブ半径は円の23.7%）。等幅の rect ではなく、ハブ側をすぼめた
     四角形（poly）にして、中心にハブの丸を1つ足す。 */
  function radialWedgeShapes(count, hubR, outerR, hubHalfDeg, outerHalfDeg) {
    const out = [["circle", 0.5, 0.5, hubR]];
    const step = 360 / count;
    for (let i = 0; i < count; i++) {
      const mid = i * step, hh = (hubHalfDeg * Math.PI) / 180, oh = (outerHalfDeg * Math.PI) / 180;
      const a = (mid * Math.PI) / 180;
      const pt = (r, da) => [+(0.5 + Math.cos(a + da) * r).toFixed(4), +(0.5 + Math.sin(a + da) * r).toFixed(4)];
      out.push(["poly", [pt(hubR * 0.94, -hh), pt(outerR, -oh), pt(outerR, oh), pt(hubR * 0.94, hh)]]);
    }
    return out;
  }
  /* ドット（不規則な散らし穴）。実機のRosco Dot Breakup（77053）を実測すると、
     等間隔の格子ではなく、小さい粒がほとんどでたまに大きい粒が混じる不規則な散らし
     （実測: 258個・直径は円の直径の1.4〜5.2%・面積の約14%が抜け）。 */
  function dotShapes(count, seed, minR, rangeR, pow) {
    let x = seed >>> 0;
    const rnd = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
    const out = [];
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * 0.47;
      const u = 0.5 + Math.cos(a) * r, v = 0.5 + Math.sin(a) * r;
      const rad = minR + Math.pow(rnd(), pow) * rangeR;
      out.push(["circle", +u.toFixed(4), +v.toFixed(4), +rad.toFixed(4)]);
    }
    return out;
  }

  const GOBOS = [
    { id: "none", name: "なし", kind: "none", shapes: [] },
    /* 回す前提（回転ゴボ相当）8種 */
    /* 3種とも jaggedShapes（木漏れ日と同じ生成器）で作る。粗・中・細は粒の大きさと数だけの
       違いにした（2026-09-13 本人指定「同じ生成器で作り直す」）。もとは手で置いた4〜9個の
       多角形・円で、木漏れ日と密度がまるで揃っていなかった。
       白と黒がおよそ半々になる数を、木漏れ日と同じやり方で実測して選んである。 */
    { id: "break-coarse", name: "ブレイクアップ（粗）", kind: "rot", note: "光を大きく割る。質感の基本",
      shapes: jaggedShapes(23, 20260913, { spread: 0.42, cluster: 0.1, near: [0.02, 0.04],
        min: 0.045, range: 0.075, pow: 1.5, jitter: 0.65, lo: 0.55, hi: 1.0, vmin: 6, vrange: 4 }) },
    { id: "break-mid", name: "ブレイクアップ（中）", kind: "rot", note: "中くらいの崩し。いちばん使いやすい",
      shapes: jaggedShapes(86, 20260913, { spread: 0.46, cluster: 0.35, near: [0.018, 0.032],
        min: 0.025, range: 0.058, pow: 1.8, jitter: 0.7, lo: 0.45, hi: 1.2, vmin: 6, vrange: 5 }) },
    { id: "break-fine", name: "ブレイクアップ（細）", kind: "rot", note: "ざらついた質感。床に敷く",
      shapes: jaggedShapes(1660, 20260913, { spread: 0.47, cluster: 0.55, near: [0.007, 0.016],
        min: 0.004, range: 0.018, pow: 1.7, jitter: 0.9, lo: 0.4, hi: 1.3, vmin: 6, vrange: 5 }) },
    { id: "foliage", name: "木漏れ日", kind: "rot", note: "フォリッジ。屋外・森。場所を決める",
      shapes: foliageShapes(500, 20260913) },
    { id: "radial", name: "放射", kind: "rot", note: "回すと強い。ライブ向き",
      shapes: radialWedgeShapes(13, 0.1185, 0.48, 1.5, 8.5) },
    { id: "spiral", name: "渦巻き", kind: "rot", note: "回すと吸い込まれて見える",
      shapes: [["poly", spiralBand(2.6, 0.44, 0.055, 140)]] },
    { id: "dots", name: "ドット", kind: "rot", note: "抽象。不規則な散らし",
      shapes: dotShapes(205, 20260913, 0.007, 0.0193, 3.4) },
    /* 回さない前提（固定ゴボ相当）4種 */
    { id: "window", name: "格子窓", kind: "stat", note: "室内。差し込む方向が出る",
      shapes: gridShapes(8, 4, 0.70, 0.51, 0.16, 0.16) },
    { id: "slit-v", name: "縦スリット", kind: "stat", note: "牢格子。切り取る",
      shapes: gridShapes(9, 4, 0.44, 0.75, 0.45, 0.15) },
    { id: "slit-h", name: "横スリット", kind: "stat", note: "ブラインド越しの光",
      shapes: blindShapes(42, 0.46, 0.75, 0.078, 0.045, 0.45) },
    /* 2026-09-13 本人指摘「三角はない。縦じま・横じまはあるけど」で、三角の抜きを雲に差し替えた。
       雲は Rosco のカタログにも Clouds & Sky として分類がある実在の系統。 */
    { id: "clouds", name: "雲", kind: "stat", note: "空・幻想。ぼかして使う",
      shapes: [["ellipse", .30,.32,.20,.11,-8], ["ellipse", .48,.26,.16,.09,6], ["ellipse", .66,.36,.18,.10,-4],
               ["ellipse", .26,.64,.17,.09,10], ["ellipse", .50,.70,.21,.11,-6], ["ellipse", .74,.62,.15,.08,8]] },
  ];
  const goboById = (id) => GOBOS.find((g) => g.id === id) || GOBOS[0];
  /* いまの模様の回転角（度）。回す速さ goboSpin が0なら goboAngle で止まる。
     回すときは経過時間に比例させる（100で毎秒36度＝10秒で1周）。 */
  const goboAngleAt = (light, tMs) => {
    if (!light) return 0;
    const spin = clamp(finite(light.goboSpin, 0), -100, 100);
    const base = finite(light.goboAngle, 0);
    const a = spin ? base + (finite(tMs, 0) / 1000) * spin * 0.36 : base;
    /* 必ず 0〜360 に畳む。JS の % は符号を残すので、反時計回り（負の速さ）だと負の角が返り、
       それを goboAngle として再投入した先（帯の筋の断面 goboProfile）が clamp で 0° に潰れて
       「光だまりは回るのに帯の筋だけ止まる」になっていた（2026-09-13 本人指摘・実測で確認）。 */
    return ((a % 360) + 360) % 360;
  };

  const describeNamedMount = (fixture, rig) => {
    const info = root.GAMMA_LIGHT_MODEL?.positionNames?.info(rig, fixture);
    return fixture.mount?.type === "position" && info?.ref === fixture.mount.positionId ? describeMount(fixture,rig) : info?.ref ? `${info.text}（名称のみ） / ${describeMount(fixture, rig)}` : describeMount(fixture, rig);
  };

  const describeCue = (light, fixture) => {
    if (!light || light.on === null || light.on === undefined) return "未設定";
    if (light.on === false) return "消灯";
    const lv = levelOf(light), lvTo = light.levelTo == null ? null : clamp(finite(light.levelTo, lv), 0, 100);
    if (lv <= 0 && (lvTo == null || lvTo <= 0)) return "消灯（強さ0%）";
    const strength = lvTo != null && Math.round(lvTo) !== Math.round(lv)
      ? `強さ${Math.round(lv)}%→${Math.round(lvTo)}%で`
      : (lv >= 100 ? "" : `強さ${Math.round(lv)}%で`);
    const gb = light.gobo && light.gobo !== "none" ? goboById(light.gobo) : null;
    const goboText = gb ? `。模様は「${gb.name}」${clamp(finite(light.goboSpin, 0), -100, 100) ? "（回す）" : ""}` : "";
    // ムービングが動きの中でズームするときだけ、広がりの変化を添える
    const zoom = fixture && isMoving(fixture) && light.beamDegTo != null
      && Math.round(light.beamDegTo) !== Math.round(beamDegOf(fixture, light))
      ? `。広がりは${Math.round(beamDegOf(fixture, light))}°→${Math.round(light.beamDegTo)}°` : "";
    const colorText = light.colorTo != null && /^#[0-9a-f]{6}$/i.test(String(light.colorTo)) && String(light.colorTo).toLowerCase() !== String(light.color || "").toLowerCase()
      ? `。色は${light.color || "#f2ead6"}→${light.colorTo}` : "";
    const face = light.surface === "back" ? "ホリゾント" : light.surface === "air" ? "空中" : light.surface === "house" ? "客席（目眩まし）" : "床";
    const sp = { slow: "ゆっくり", normal: "普通の速さ", fast: "速く" }[light.speed] || "普通の速さ";
    const path = light.path || {};
    if (path.kind === "line") {
      const diag = Math.abs((path.a.hM || 0) - (path.b.hM || 0)) > 0.15 ? "（斜めの軌道）" : "";
      return `${strength}${face}の${posWord(path.a)}〜${posWord(path.b)}を往復${diag}（${sp}）。${path.start === "b" ? posWord(path.b) : posWord(path.a)}から開始${zoom}${colorText}${goboText}`;
    }
    if (path.kind === "circle") return `${strength}${face}の${posWord(path.c)}を中心に半径約${Math.round(path.r * 1000)}mmで${PLANE_LABEL[path.plane] || "水平の円"}・${path.dir === "ccw" ? "反時計回り" : "時計回り"}（${sp}）${zoom}${colorText}${goboText}`;
    return `${strength}${face}の${posWord(path.a || newPoint())}を静止で当てる${zoom}${colorText}${goboText}`;
  };

  /* 下手⇄上手のコピー（配置のみ。2026-09-11 本人回答＝初回は配置だけでよい）。
     トラス・床は u→1−u、横は side を反転。奥行き・高さ・トラス所属はそのまま。 */
  /* ---------- 幕・ホリゾント（2026-09-13 本人要望で移植） ----------
     出典: stage-machinery.js:40-53 machineryParts() の curtain 分岐（そのまま移植）と、
     stage-sketch.js:16850 curtainKindName() の語彙。5種のうち、この試作では実際に
     「前幕」「ホリゾント幕」の2枚だけを下敷きの見本として置く（残り3種もデータ形は同じなので、
     あとで足すだけでよい）。
     開閉(open, 0〜100)の扱いは本体と同じ:
       ・前幕／中割り幕／袖幕＝左右2枚が中央から閉じる。全開でも束ねた最小幅が残る。
       ・振り落とし／ホリゾント＝1枚。開く＝上へ消える（lift が上がる）。 */
  const CURTAIN_KIND_LABEL = Object.freeze({
    front: "前幕・引き割り", traveler: "中割り幕", drop: "振り落とし・上下する幕",
    leg: "袖幕", cyc: "ホリゾント幕",
  });
  const CURTAIN_KINDS = Object.freeze(["front", "traveler", "leg", "drop", "cyc"]);
  const curtainKindLabel = (kind) => CURTAIN_KIND_LABEL[kind] || kind;
  /* 幕の板（1〜2枚）を返す。ox=幕の中心からの左右オフセット(m)・w=その板の幅(m)・
     h=高さ(m)・lift=床からその板の下端までの高さ(m)。dims={w,h,lift} はメートル実寸で渡す
     （出典: stage-machinery.js:40-53 の curtain 分岐、変数名も合わせた）。 */
  const curtainParts = (piece, dims) => {
    if (!piece || !dims) return [];
    const open = clamp(finite(piece.open, 0), 0, 100) / 100;
    const lift = finite(dims.lift, 0);
    if (piece.curtainKind === "drop" || piece.curtainKind === "cyc") {
      return [{ ox: 0, w: dims.w, h: dims.h, lift: lift + dims.h * open }];
    }
    /* 一文字幕（いちもんじまく）。バトンの手前に吊る短い横長の幕で、客席から
       灯体とバトンを隠すためのもの。左右に開かず1枚のまま、上から下へ垂れる。
       dims.h が布の丈（垂れ下がる長さ）、dims.lift がその下端の高さ。
       2026-09-13 本人要望で追加（本体 stage-machinery.js には無い種類）。 */
    if (piece.curtainKind === "border") {
      return [{ ox: 0, w: dims.w, h: dims.h, lift }];
    }
    const gathered = dims.w * 0.08;
    const panelWidth = Math.max(gathered, dims.w * (1 - open) / 2);
    const offset = (dims.w - panelWidth) / 2;
    return [-1, 1].map((side) => ({ ox: side * offset, w: panelWidth, h: dims.h, lift }));
  };

  const mirrorMount = (mount) => {
    const m = JSON.parse(JSON.stringify(mount || {}));
    if (m.type === "truss" || m.type === "floor" || m.type === "front") m.u = 1 - clamp(finite(m.u, 0.5), 0, 1);
    else if (m.type === "side") m.side = m.side === "shimote" ? "kamite" : "shimote";
    return m;
  };

  /* 2灯の照射先・軌道を舞台センター線で鏡映する純関数。
     器具の取り付け位置や、相手灯の色・強さ・点灯状態には触れない。 */
  const mirrorAimCompatible = (source, partner) => {
    const a = source && source.path, b = partner && partner.path;
    return Boolean(a && b && source.surface === partner.surface && a.kind === b.kind
      && ["still", "line", "circle", "eight"].includes(a.kind));
  };
  const mirrorAimPoint = (point, axisU = 0.5) => ({
    ...JSON.parse(JSON.stringify(point || newPoint())),
    u: Number(clamp(2 * clamp(finite(axisU, 0.5), 0, 1) - clamp(finite(point && point.u, 0.5), 0, 1), 0, 1).toFixed(6)),
  });
  const mirrorAimPath = (source, partner, axisU = 0.5) => {
    const next = JSON.parse(JSON.stringify(partner || {}));
    if (!mirrorAimCompatible(source, partner)) return next;
    const path = JSON.parse(JSON.stringify(source.path));
    if (path.kind === "still") path.a = mirrorAimPoint(path.a, axisU);
    else if (path.kind === "line") { path.a = mirrorAimPoint(path.a, axisU); path.b = mirrorAimPoint(path.b, axisU); }
    else {
      path.c = mirrorAimPoint(path.c, axisU);
      /* 舞台横から見た縦軌道は左右(x)成分を持たないため、中心だけ写す。
         それ以外は軌道面を鏡映する。円は進行方向を反転し、8の字は半周位相をずらす。 */
      if ((path.plane || "horizontal") !== "sideVertical") {
        path.tilt = -finite(path.tilt, 0);
        if (path.kind === "circle") {
          path.start = ((finite(path.start, 0) + 0.5) % 1 + 1) % 1;
          path.dir = path.dir === "ccw" ? "cw" : "ccw";
        } else {
          path.start = ((finite(path.start, 0) + 0.5) % 1 + 1) % 1;
        }
      }
    }
    next.path = path;
    return next;
  };

  /* ゴボ（模様）の形。単位の形空間（−0.5〜0.5）の Path2D を1度だけ組んで使い回す
     （木漏れ日は多角形が数百。灯ごと・図ごと・毎コマ組み直すと重い）。
     ★2026-09-19: 舞台モードの共有部品（stage-light-render.js）も同じ形を使うので、app.js からここへ移した。
       形の正本はここ1か所。 */
  const goboPathCache = new Map();
  const goboPath = (g) => {
    if (!g || typeof Path2D === "undefined") return null;
    const hit = goboPathCache.get(g.id); if (hit) return hit;
    const p = new Path2D();
    const X = (u) => u - 0.5, Y = (v) => v - 0.5;
    (g.shapes || []).forEach((sp) => {
      const k = sp[0];
      if (k === "poly") { sp[1].forEach(([u, v], i) => { const x = X(u), y = Y(v); i ? p.lineTo(x, y) : p.moveTo(x, y); }); p.closePath(); }
      else if (k === "circle") { p.moveTo(X(sp[1]) + sp[3], Y(sp[2])); p.arc(X(sp[1]), Y(sp[2]), sp[3], 0, Math.PI * 2); }
      else if (k === "rect") { const x = X(sp[1]), y = Y(sp[2]), w = sp[3], h = sp[4]; p.moveTo(x, y); p.lineTo(x + w, y); p.lineTo(x + w, y + h); p.lineTo(x, y + h); p.closePath(); }
      else if (k === "ellipse") { p.moveTo(X(sp[1]) + sp[3], Y(sp[2])); p.ellipse(X(sp[1]), Y(sp[2]), sp[3], sp[4], (finite(sp[5], 0) * Math.PI) / 180, 0, Math.PI * 2); }
      else if (k === "ring") { const rr = sp[1], w = sp[2]; p.moveTo(rr + w, 0); p.arc(0, 0, rr + w, 0, Math.PI * 2); p.moveTo(rr, 0); p.arc(0, 0, rr, 0, Math.PI * 2, true); }
      else if (k === "spoke") { const cnt = sp[1], hw = sp[2], len = sp[3];
        for (let i = 0; i < cnt; i++) { const a = (i / cnt) * Math.PI * 2;
          const dx = Math.cos(a), dy = Math.sin(a), nx = -dy * hw, ny = dx * hw;
          p.moveTo(nx, ny); p.lineTo(dx * len + nx, dy * len + ny); p.lineTo(dx * len - nx, dy * len - ny); p.lineTo(-nx, -ny); p.closePath(); } }
    });
    goboPathCache.set(g.id, p);
    return p;
  };

  /* 駒は登録順でなく、見る側からの奥行き順に塗る。元の保存配列は並べ替えない。 */
  function stagePieceDepth(piece, view) {
    if (view === "shimote") return 1 - finite(piece.u, 0.5);
    if (view === "kamite") return finite(piece.u, 0.5);
    return finite(piece.v, 0.5);
  }
  function orderStagePieces(pieces, view = "front") {
    return (Array.isArray(pieces) ? pieces : []).slice().sort((a, b) => {
      const people = Number(a.kind === "performer") - Number(b.kind === "performer");
      if (view === "plan") return people || ((finite(a.base, 0) + finite(a.hM, 0)) - (finite(b.base, 0) + finite(b.hM, 0)));
      return stagePieceDepth(a, view) - stagePieceDepth(b, view) || people;
    });
  }

  /* ---------- キューの時間 timing（2026-09-27） ----------
   * timing = { fadeInSec, fadeOutSec?, delayInSec, delayOutSec?, curve?, by?:{position,beam,color}, snap?:{delaySec}, mib? }
   *   fadeIn ＝明るくなる方・強さ以外の属性の既定（MA3 の In Fade）／fadeOut＝暗くなる方（省略＝In と同じ）
   *   by.position などは {fadeSec, delaySec, curve} で属性群ごとに上書き（省略＝In と同じ）
   *   snap.delaySec＝模様・カッター・レーザー種の切替を遅らせる秒／mib＝消えていた灯は先回りして向く
   * 無ければカット（全部 0 秒）。 */
  const normalizeTiming = (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const sec = (v, d) => clamp(finite(v, d), 0, 600);
    const opt = (v) => (v === undefined || v === null ? null : sec(v, 0));
    const fam = (v) => (v && typeof v === "object"
      ? { fadeSec: opt(v.fadeSec), delaySec: opt(v.delaySec), curve: v.curve === undefined ? null : normalizeCurve(v.curve) }
      : null);
    const by = raw.by && typeof raw.by === "object" ? raw.by : {};
    return {
      fadeInSec: sec(raw.fadeInSec, 0), fadeOutSec: opt(raw.fadeOutSec),
      delayInSec: sec(raw.delayInSec, 0), delayOutSec: opt(raw.delayOutSec),
      curve: normalizeCurve(raw.curve),
      by: { position: fam(by.position), beam: fam(by.beam), color: fam(by.color) },
      snapDelaySec: sec(raw.snap && raw.snap.delaySec, sec(raw.snapDelaySec, 0)),
      mib: raw.mib === true,
    };
  };
  const timingFamily = (T, family) => {
    if (family === "in") return { fade: T.fadeInSec, delay: T.delayInSec, curve: T.curve };
    if (family === "out") return { fade: T.fadeOutSec === null ? T.fadeInSec : T.fadeOutSec, delay: T.delayOutSec === null ? T.delayInSec : T.delayOutSec, curve: T.curve };
    const f = T.by[family];
    return { fade: f && f.fadeSec !== null ? f.fadeSec : T.fadeInSec, delay: f && f.delaySec !== null ? f.delaySec : T.delayInSec, curve: f && f.curve ? f.curve : T.curve };
  };
  /* GO からの経過 tGoMs で、その属性群の進み具合（0〜1。swing なら一時的に 1 を越える） */
  const timingProgress = (timing, tGoMs, family) => {
    const T = normalizeTiming(timing);
    if (!T) return 1;
    const { fade, delay, curve } = timingFamily(T, family || "in");
    const t = finite(tGoMs, 0) / 1000;
    if (t < delay) return 0;
    if (fade <= 0) return 1;
    return curveMap(Math.min(1, (t - delay) / fade), curve);
  };
  /* 切替が完全に終わるまでの長さ（ms）。0 ならカット。 */
  const transitionMs = (timing) => {
    const T = normalizeTiming(timing);
    if (!T) return 0;
    const ends = ["in", "out", "position", "beam", "color"].map((fam) => { const f = timingFamily(T, fam); return f.fade + f.delay; });
    return Math.max(0, ...ends, T.snapDelaySec) * 1000;
  };
  const worldToPoint = (w, dims) => {
    const p = { u: clamp(w.x / dims.W + 0.5, 0, 1), v: clamp(w.y / dims.D, 0, 1), hM: clamp(w.z, 0, dims.H) };
    if (w.y > dims.D) p.aheadM = clamp(w.y - dims.D, 0, HOUSE_AHEAD_MAX);
    return p;
  };
  const mixHex = (a, b, p) => {
    const ok = (v) => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v);
    if (!ok(a) || !ok(b)) return ok(b) ? b : a;
    const q = clamp(finite(p, 0), 0, 1);
    const ch = (i) => { const x = parseInt(a.slice(i, i + 2), 16), y = parseInt(b.slice(i, i + 2), 16); return Math.round(x + (y - x) * q); };
    return "#" + [1, 3, 5].map((i) => ch(i).toString(16).padStart(2, "0")).join("");
  };
  const SNAP_KEYS = ["gobo", "shutter", "laser", "goboSoft"];
  /* 前のキュー prevCue から次のキュー nextCue へ、timing に従って移る途中の「描画用キュー」。
     ctx = { timing, tGoMs(GOからの実時間), tFxMs(動きの時計), dims, fixtures }
     戻り値 { cue, done, progress }。done なら nextCue そのもの（動き・levelTo はそのまま生きる）。 */
  const blendCues = (prevCue, nextCue, ctx) => {
    const T = normalizeTiming(ctx && ctx.timing);
    const next = nextCue && typeof nextCue === "object" ? nextCue : { lights: {}, groups: [] };
    const tGo = finite(ctx && ctx.tGoMs, 0);
    if (!T || tGo >= transitionMs(T)) return { cue: next, done: true, progress: 1 };
    const prev = prevCue && typeof prevCue === "object" ? prevCue : { lights: {}, groups: [] };
    const tFx = finite(ctx && ctx.tFxMs, 0);
    const dims = (ctx && ctx.dims) || DEFAULT_DIMS;
    const byId = new Map(((ctx && ctx.fixtures) || []).map((f) => [f.id, f]));
    const pIn = timingProgress(T, tGo, "in"), pOut = timingProgress(T, tGo, "out");
    const pPos = timingProgress(T, tGo, "position"), pBeam = timingProgress(T, tGo, "beam"), pCol = timingProgress(T, tGo, "color");
    const snapped = tGo / 1000 >= T.snapDelaySec;
    const lights = {};
    const ids = new Set([...Object.keys(prev.lights || {}), ...Object.keys(next.lights || {})]);
    ids.forEach((id) => {
      const a = (prev.lights || {})[id] || null, b = (next.lights || {})[id] || null;
      const fixture = byId.get(id) || null;
      const aLit = isLit(a), bLit = isLit(b);
      /* 舞台側（ctx.representative）は概略図＝動きの時計を持たず「始めの値」で描くので、位相も 0 に固定する
         （levelTo・beamDegTo・colorTo の途中の値を混ぜると GO の瞬間に飛ぶ。2026-09-27 Safari 指摘の続き）。 */
      const repMode = Boolean(ctx && ctx.representative);
      const phA = repMode ? 0 : (a ? paramPhase(a, prev, id, tFx) : 0), phB = repMode ? 0 : (b ? paramPhase(b, next, id, tFx) : 0);
      const La = aLit ? levelAt(a, phA) : 0, Lb = bLit ? levelAt(b, phB) : 0;
      const L = clamp(La + (Lb - La) * (Lb >= La ? pIn : pOut), 0, 100);
      const out = { ...(b || a) };
      /* 位置。前の狙い先（消えていても向きは残っている）から次の狙い先へ。
         両方が動いていても、その瞬間どうしを混ぜる。MIB＝消えていた灯は先回り（見えない間に済ませる）。 */
      /* 2026-09-27 本人指摘（Safari）: 軌道が同じキュー同士（色だけ替える等）で、混ぜている間だけ「その瞬間の位置に静止」へ
         置き換えると、舞台の概略図（動く光は代表点で描く）では GO で代表点→瞬間位置へ飛び、終わると戻る＝瞬間移動に見えた。
         ①軌道が同じなら位置は触らない（動きはそのまま続く）。②ctx.representative（舞台側）は、その瞬間の位置でなく
         代表点（線＝A・円＝中心・点の列＝最初の点・静止＝A）どうしを混ぜる＝概略図の描き方と同じ約束。 */
      const samePath = Boolean(a && b && a.path && b.path && JSON.stringify(a.path) === JSON.stringify(b.path));
      const repPoint = (p) => (!p ? null : p.kind === "poly" ? (Array.isArray(p.points) ? p.points[0] || null : null)
        : (p.kind === "circle" || p.kind === "eight") ? (p.c || p.a || null) : (p.a || null));
      const aimWorld = (light, cueOf, fid) => {
        if (!light || !light.path) return null;
        if (ctx && ctx.representative) { const pt = repPoint(light.path); return pt ? targetAt({ ...light, on: true, path: { kind: "still", a: pt } }, cueOf, fid, 0, dims) : null; }
        return targetAt({ ...light, on: true }, cueOf, fid, tFx, dims);
      };
      const ta = samePath ? null : aimWorld(a, prev, id);
      const tb = samePath ? null : aimWorld(b, next, id);
      if (samePath) { /* 位置はそのまま（b の軌道が生きる） */ }
      else if (b && tb) {
        const mib = T.mib && !aLit;
        if (ta && !mib && pPos < 1) {
          const w = { x: ta.x + (tb.x - ta.x) * pPos, y: ta.y + (tb.y - ta.y) * pPos, z: ta.z + (tb.z - ta.z) * pPos };
          out.path = { kind: "still", a: worldToPoint(w, dims) };
        }
      } else if (a && a.path) { out.path = a.path; if (a.surface) out.surface = a.surface; }
      /* 広がり（ズーム）。ムービングだけ。 */
      if (a && b && fixture && isMoving(fixture) && pBeam < 1) {
        const da = beamDegAt(fixture, a, phA), db = beamDegAt(fixture, b, phB);
        if (Math.abs(da - db) > 1e-6) { out.beamDeg = da + (db - da) * pBeam; out.beamDegTo = null; }
      }
      /* スナップ属性（模様・カッター・レーザー種）は遅れの後に一瞬で切り替わる。 */
      if (a && b && !snapped) SNAP_KEYS.forEach((k) => { if (a[k] !== undefined) out[k] = a[k]; else delete out[k]; });
      /* 色は連続的に混ざる（CMY/RGB の実機と同じ。カラーホイールの実機はスナップだが型番は持たない）。 */
      if (a && b && a.color && b.color && (pCol < 1 || (colorSnaps(fixture) && !snapped))) {
        /* 第6弾: 終わりの色（colorTo）を持つ灯は、その瞬間の色どうしを混ぜる。混ぜている間は終わりの色を止め、色の秒が終われば次のキューの colorTo が生きる。 */
        const ca = colorAt(a, phA, fixture), cb = colorAt(b, phB, fixture);
        if (ca.toLowerCase() !== cb.toLowerCase()) {
          /* カラーホイール機は混色できない＝スナップの遅れ（snap.delaySec）の後に一瞬で替わる（模様・カッターと同じ扱い） */
          out.color = colorSnaps(fixture) ? (snapped ? cb : ca) : mixHex(ca, cb, pCol); out.colorTo = null;
        }
      }
      out.on = L > 0 ? true : (b ? b.on : false);
      out.level = L; out.levelTo = null;
      lights[id] = out;
    });
    return { cue: { ...next, lights }, done: false, progress: Math.min(pIn, pOut, pPos, pBeam, pCol) };
  };

  /* ---------- キュー番号・きっかけ・自動送り・略語（v2-1／v2-2・2026-09-27） ----------
   * 設計: docs/cue-design-research-2026-09-27/index.html（本人が推奨5点を承認）
   *   番号 no: 通しの文字（"12" / "12.5"）。Eos と同じく小数で間に入れる。ショー全体で一意。
   *   きっかけ trigger: 台詞・音楽・動作の文字。
   *   自動送り follow: { mode: "follow"（GOから sec 秒後）| "hang"（切替が終わってから sec 秒後）, sec }。無ければ GO 待ち。
   *   略語: 前の状態と次の状態と秒数から F.I／C.I／F.O／C.O／F.C／C.C を決める（日本の現場の書き方）。 */
  const CUE_NO_RE = /^\d{1,4}(\.\d{1,3})?$/;
  const cueNoValid = (no) => typeof no === "string" && CUE_NO_RE.test(no);
  const cueNoValue = (no) => (cueNoValid(no) ? Number(no) : NaN);
  const cueNoText = (value) => { const v = Math.round(finite(value, 0) * 1000) / 1000; return Number(v.toFixed(3)).toString(); };
  /* 次の整数番号（今ある番号の最大の整数部＋1、最小1） */
  const cueNumberNext = (existing) => {
    let max = 0;
    (existing || []).forEach((no) => { const v = typeof no === "number" ? no : cueNoValue(no); if (Number.isFinite(v) && v > max) max = v; });
    return cueNoText(Math.floor(max) + 1);
  };
  /* a と b の間の番号（小数で挿入）。b が無ければ a の次の整数、a が無ければ b の手前。入らなければ null。 */
  const cueNumberBetween = (a, b) => {
    const va = a === undefined || a === null ? NaN : (typeof a === "number" ? a : cueNoValue(a));
    const vb = b === undefined || b === null ? NaN : (typeof b === "number" ? b : cueNoValue(b));
    if (!Number.isFinite(va) && !Number.isFinite(vb)) return "1";
    if (!Number.isFinite(vb)) return cueNoText(Math.floor(va) + 1);
    if (!Number.isFinite(va)) return vb > 1 ? cueNoText(Math.max(0.001, vb - 1 >= 1 ? Math.floor(vb - 1) : vb / 2)) : cueNoText(vb / 2);
    if (vb - va < 0.002) return null;
    /* できるだけ切りのよい値: 差が1以上なら整数、0.1以上なら小数1桁、それ以下は中点 */
    if (vb - va > 1) return cueNoText(Math.floor(va) + 1);
    const mid = (va + vb) / 2;
    const tenth = Math.round(mid * 10) / 10;
    if (tenth > va && tenth < vb) return cueNoText(tenth);
    return cueNoText(mid);
  };
  const FOLLOW_MODES = ["go", "follow", "hang"];
  const normalizeFollow = (raw) => (raw && typeof raw === "object" && (raw.mode === "follow" || raw.mode === "hang")
    ? { mode: raw.mode, sec: clamp(finite(raw.sec, 0), 0, 600) } : null);
  /* GO から何 ms 後に次を出すか。null＝自動では出さない（GO 待ち） */
  const followDelayMs = (follow, timing) => {
    const f = normalizeFollow(follow); if (!f) return null;
    return (f.mode === "hang" ? transitionMs(timing) : 0) + f.sec * 1000;
  };
  const cueLit = (cue) => Boolean(cue && cue.lights) && Object.values(cue.lights).some(isLit);
  const cueNotation = (prevCue, cue, timing) => {
    const T = normalizeTiming(timing);
    const fadeIn = T ? T.fadeInSec : 0, fadeOut = T ? (T.fadeOutSec === null ? T.fadeInSec : T.fadeOutSec) : 0;
    const before = cueLit(prevCue), after = cueLit(cue);
    if (!before && !after) return "";
    if (!before && after) return fadeIn > 0 ? "F.I" : "C.I";
    if (before && !after) return fadeOut > 0 ? "F.O" : "C.O";
    return fadeIn > 0 || fadeOut > 0 ? "F.C" : "C.C";
  };
  const followText = (follow) => { const f = normalizeFollow(follow); if (!f) return "GO待ち"; return f.mode === "hang" ? `終わって${cueNoText(f.sec)}秒後` : `GOから${cueNoText(f.sec)}秒後`; };

  root.RIG_ENGINE = Object.freeze({
    CURVE_PRESETS, normalizeCurve, curveMap, POLY_MODES, polyPoints, polyTraversal, polyCycleMs, polyAt,
    normalizeTiming, timingProgress, transitionMs, blendCues, mixHex, worldToPoint,
    CUE_NO_RE, cueNoValid, cueNoValue, cueNoText, cueNumberNext, cueNumberBetween, FOLLOW_MODES, normalizeFollow, followDelayMs, cueLit, cueNotation, followText,
    DEFAULT_DIMS, FLOOR_FIXTURE_Z, SIDE_OFFSET_M, CYC_MOUNT_V, CYC_REACH_MAX, HOUSE_AHEAD_MAX, cycBarSpan, SPEED_PERIOD_MS, PLANE_VALUES, PLANE_LABEL,
    clamp, finite, stagePieceDepth, orderStagePieces,
    newTruss, newFixture, isMoving, isLaser, MIRROR_BALL, isMirrorBall, mirrorBallOf, mirrorBallCentre, mirrorBallAimPoint, mirrorBallTargetOf, beamDegOf, opticalSoftnessOf, spotRadiusM, spotEllipse, spotFalloff, beamLanding, trussById, trussRow, fixtureWorld,
    newPoint, newLightCue, levelOf, isLit, levelAt, beamDegAt, colorAt, colorSnaps, strobeMul, paramPhase, mountSpot, GOBOS, goboById, goboAngleAt, goboPath, constrainPointToSurface, periodMs, groupEffect,
    pointWorld, planeVec, circleOffset, eightOffset, targetAt, pathGuide, mirrorMount, mirrorAimCompatible, mirrorAimPoint, mirrorAimPath,
    FRONT_SEATS, frontPerspSetup, makeFrontPerspProjector, frontPerspToUH,
    FRONT_FAR_CAMERA_M, frontFarSetup, makeFrontFarProjector, frontFarToUH,
    makePlanProjector, makeFrontProjector, makeSideProjector, planToUV, frontToUH, sideToVH,
    describeMount, describeNamedMount, describeCue,
    CURTAIN_KINDS, curtainKindLabel, curtainParts,
    BARN_KEYS, SHUTTER_MIN, SHUTTER_MAX, SHUTTER_ROT_MAX, newShutter, barnOf, barnActive, shutterActive, frameDoors, doorCutInEllipse, beamLandingSilhouette,
  });
})(typeof window !== "undefined" ? window : globalThis);
