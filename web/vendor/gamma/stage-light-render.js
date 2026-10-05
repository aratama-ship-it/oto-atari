/* 光の塗りの共有部品（2026-09-18・段階1「光だまり」）
 *
 * 舞台スケッチ本体と、照明を組む画面が、**同じ塗り方**で光を出すための1ファイル。
 * ここで塗るのは「光が面に落ちた楕円」だけ。帯（三角）・にじみ・ゴボ・カッター・
 * 体積光・作業灯の暗幕は段階2以降で足す。
 * 設計とトークン表: docs/light-pool-2026-09-18/DESIGN.md
 *
 * ★楕円そのものは計算しない。照明モードが実際に使っている
 *   `RIG_ENGINE.spotEllipse(S, T, 広がり, 面)` の結果（世界座標の中心と2本の半径ベクトル）を受け取る。
 *   同じ計算を2つ持つと、片方だけ直したときに図がずれる。
 *
 * ★円周は**世界座標で刻んでから投影する**。こうすると、正面図の擬似パース・平面図・
 *   3Dの透視・側面図のどれでも、光が床に貼りついたまま正しく歪む。
 *   投影 P の中身を知る必要がない（大道具の共有部品 stage-set-render.js と同じ考え方）。
 *
 * 世界座標の約束（stage-set-render.js と同じ）:
 *   x = (u - 0.5) × 舞台幅 ／ y = v × 舞台奥行き（奥が小さい） ／ z = 高さ(m)
 */
(function (root) {
  "use strict";

  const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, lower, upper) => Math.min(upper, Math.max(lower, value));
  const rgba = (hex, alpha) => {
    const text = typeof hex === "string" && /^#[0-9a-f]{6}$/i.test(hex) ? hex : "#f2ead6";
    const value = parseInt(text.slice(1), 16);
    return `rgba(${(value >> 16) & 255},${(value >> 8) & 255},${value & 255},${alpha})`;
  };

  /* トークン（docs/light-pool-2026-09-18/DESIGN.md の表と一致させること）。
     ★数値は照明モード（light-design/app.js の drawBeam）から持ってきたもの。勝手に変えない。 */
  const VISUAL_GAIN = 1.8;      // 図として見えるように持ち上げる倍率（照明モードと同じ）
  // Only the basic pool/beam alpha participates in the isolated dimming trial.
  const visualAlpha = (value) => root.STAGE_LIGHT_EVAL
    ? root.STAGE_LIGHT_EVAL.previewAlpha(value, root.GAMMA_LIGHT_PREVIEW_MODE)
    : clamp(value * VISUAL_GAIN, 0, 1);
  const BEAM_SOFT = 1.26;       // 縁の半影のぶん、楕円を少し広げる
  const ALPHA_CORE = 0.50;      // 中心の濃さ（2026-09-19 本人決定「全体+50%」で 0.34→0.50）
  const ALPHA_MID = 0.27;       // 芯の外（同上 0.18→0.27）
  const ALPHA_EDGE = 0.075;     // 縁の手前（同上 0.05→0.075）
  const SOFT_DEFAULT = 2;       // 縁の柔らかさの既定（0〜10）
  const MIN_AREA_PX = 4;        // これ未満は潰れている＝その図では線にしか見えない
  const MAX_TEMP_PX = 1024;     // 濃淡用の一時キャンバスの上限
  /* 模様・カッターの無い光だまり（長軸の減衰だけ）の一時キャンバスの上限（2026-10-05・v0.2.95）。
     なめらかな放射グラデーション×一次の濃淡なので 512px でも画素は見分けがつかない（試験場 F-4 で実測一致）。
     毎コマ 1024² を作っていたのを 4分の1にする。模様・カッターのある灯は従来どおり MAX_TEMP_PX（形が崩れる）。
     調査: docs/research-2026-10-04-light-paint-perf/ */
  const SMOOTH_POOL_TEMP_PX = 512;
  /* 筋のシートの保持（2026-10-05・v0.2.96）。光の筋は灯・カメラ・濃淡が動かない間は毎コマ同じ絵なので、できあがった
     シートを幾何の鍵つきで持ち、次からは貼るだけにする。★同じ鍵が2回目に現れたときだけ保存する（動く灯の毎コマ違う鍵で
     コピーを作り続けない）。★合計の画素数に上限（8Mpx≒32MB）。古い順に捨て、捨てた canvas は 0×0 にして Safari の
     canvas メモリを返す。鍵に入る値は絵に効くもの全部（点・色・濃さ・柔らかさ・濃淡の色止め・canvas の大きさと変換）。 */
  const BEAM_CACHE_MAX_PX = 8000000;
  const BEAM_CACHE_PENDING_MAX = 256;
  const BAND_ALPHA = 0.24;      // 光の帯（空気の中の筋）の濃さ。光だまりより薄い（同上 0.16→0.24）
  /* ★2026-09-19 本人決定: 筋と光だまりを**同じ比率**で上げる。片方だけ上げると、R-1 で滑らかに
     なった「筋の先と光だまりのつながり」が段差へ戻る（本人が良いと評価した点なので崩さない）。 */
  const BAND_MIN_PX = 8;        // 出どころと着地がこれより近いと、帯は点になるので描かない
  const LINE_ALPHA = 0.55;      // 真上から見る図で引く破線の濃さ
  const LINE_MIN_PX = 6;        // 破線もこれより近ければ引かない
  const DARK = "13,14,16";      // 作業灯を消したときの地の色（照明モードと同じ）
  const HOLE_BAND = 0.85;       // 真上から見る図で、破線の通り道を抜く強さ（照明モードと同じ）
  const HOLE_LINE_PX = 5;       // 真上から見る図の破線の穴の太さ（片側）

  /* R-1「灯体から遠いほど筋を弱める」（2026-09-19・本人決定 D1＝既定の見え方として置き換える）。
     設計: docs/beam-haze-2026-09-19/DESIGN.md
     ★視線が円錐を横切る弦長 ∝ r、密度 ∝ 1/r² なので積分した輝度は ∝ 1/r。
       ただし生の 1/r は灯体の位置で発散し、視線が光軸に近いと弦長近似そのものが崩れる。
       **物理の再現ではなく「一様な三角形が板に見える」のを直す知覚補正**として扱う。
     ★光だまりの spotFalloff（面の 1/r² × ランバート余弦）とは別物。混ぜない。 */
  const BEAM_FALL_R0 = 0.55;    // 効き始め（灯体→着地を1とした比）
  const BEAM_FALL_P = 0.85;     // 減衰の鋭さ（1.0で 1/r 相当）
  const BEAM_FALL_LO = 0.45;    // 下限。着地側が消えすぎないように
  const BEAM_FALL_HI = 1.35;    // 上限。灯体側が飽和しないように
  const BEAM_FALL_STOPS = 9;    // 長さ方向の色止めの数（spotFalloff の9点に合わせる）
  const BEAM_FALL_NORM_T = 0.5; // ここを1.0に正規化する＝筋の中ほどは今までと同じ濃さ
  const BEAM_LANDING_FADE_START = 0.72; // 着地点では光だまりへ溶かし、三角の底辺を見せない
  /* R-2「空気のむら（世界に固定された霧）」（2026-09-19・本人決定「R-2 を『もや』にする。段階5③は棚上げ」）。
     ★つまみは1つ＝照明デザインのシーンごとの `environment.haze`（0〜100・照明を組む画面の値・既定35）。
       hazeAmount(haze) で振れ幅へ写す: 100 → HAZE_MAX、35 → 0.15、70 → 0.30（設計 §4-4 の「確認用 0.30」）。
     ★値が無いとき（HAZE_AMOUNT）は 0＝むら無し（本人決定 D2）。0 なら計算経路に入らない。
     ★むらは**世界座標だけ**の値ノイズ。画面座標・カメラ・時刻を混ぜない（正面図・平面図・3Dで同じ霧）。
       既定は静止（時間で動かさない＝検証の再現性）。 */
  const HAZE_AMOUNT = 0;
  const HAZE_MAX = 0.43;        // environment.haze=100 のときの振れ幅（±）
  const HAZE_SCALE_M = 2.0;     // むら1つの大きさ(m)
  function hazeAmount(haze) {
    const v = finite(haze, NaN);
    if (!Number.isFinite(v)) return HAZE_AMOUNT;
    return clamp(v, 0, 100) / 100 * HAZE_MAX;
  }

  let temp = null;
  function tempCanvas(size) {
    if (typeof document === "undefined") return null;
    if (!temp) temp = document.createElement("canvas");
    if (temp.width !== size || temp.height !== size) { temp.width = size; temp.height = size; }
    return temp;
  }

  /* ★筋の一時キャンバスは光だまり（temp）と**別に持つ**。
     共用すると、同じフレームの中で光だまりと筋が取り合って中身が混ざる。 */
  let beamSheet = null;
  function beamCanvas(width, height) {
    if (typeof document === "undefined") return null;
    if (!beamSheet) beamSheet = document.createElement("canvas");
    if (beamSheet.width !== width || beamSheet.height !== height) {
      beamSheet.width = width; beamSheet.height = height;
    }
    return beamSheet;
  }

  let mask = null;
  function maskCanvas(width, height) {
    if (typeof document === "undefined") return null;
    if (!mask) mask = document.createElement("canvas");
    if (mask.width !== width || mask.height !== height) { mask.width = width; mask.height = height; }
    return mask;
  }

  const add = (point, vector) => ({ x: point.x + vector.x, y: point.y + vector.y, z: point.z + vector.z });

  /* ---------- 模様（ゴボ）とカッター（2026-09-19・段階5） ----------
     形の正本は照明モードと同じ RIG_ENGINE（GOBOS／goboPath／goboAngleAt／doorCutInEllipse）。
     ここで持つのは「一時キャンバスへ白で形を塗って、光だまりに掛ける」ことだけ。 */
  const GOBO_SOFT_DEFAULT = 6;      // 照明モードの既定（goboSoft 0〜100）
  const GOBO_BLUR_RATIO = 0.35;     // ぼけ幅＝光だまりの半径×(soft/100)×これ（照明モードと同じ）
  let goboSheet = null;
  let goboBlur = null;
  function goboOf(pool) {
    const engine = root.RIG_ENGINE || null;
    if (!pool || !pool.gobo || !engine || typeof engine.goboById !== "function"
      || typeof engine.goboPath !== "function") return null;
    const g = engine.goboById(pool.gobo);
    return g && Array.isArray(g.shapes) && g.shapes.length ? g : null;
  }
  function goboAngleOf(pool, tMs) {
    const engine = root.RIG_ENGINE || null;
    if (!engine || typeof engine.goboAngleAt !== "function") return finite(pool.goboAngle, 0);
    return engine.goboAngleAt({ goboSpin: finite(pool.goboSpin, 0), goboAngle: finite(pool.goboAngle, 0) }, finite(tMs, 0));
  }
  /* 白で塗った形（大きさ size の正方形・中心が光だまりの中心・半径 radius＝単位1）。
     ぼかしは shadowBlur（Safari は ctx.filter を黙って無視する）。 */
  function goboMaskSheet(g, size, radius, angleDeg, soft) {
    if (typeof document === "undefined") return null;
    const path = root.RIG_ENGINE.goboPath(g);
    if (!path) return null;
    if (!goboSheet) goboSheet = document.createElement("canvas");
    if (goboSheet.width !== size || goboSheet.height !== size) { goboSheet.width = size; goboSheet.height = size; }
    const m = goboSheet.getContext("2d");
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, size, size);
    m.translate(size / 2, size / 2);
    m.rotate((angleDeg * Math.PI) / 180);
    m.fillStyle = "#fff";
    m.scale(radius * 2, radius * 2);
    m.fill(path);                       // nonzero（照明モードと同じ。evenodd だと重なりが穴になる）
    const blur = (clamp(finite(soft, GOBO_SOFT_DEFAULT), 0, 100) / 100) * radius * GOBO_BLUR_RATIO;
    if (blur <= 0.12) return goboSheet;
    if (!goboBlur) goboBlur = document.createElement("canvas");
    if (goboBlur.width !== size || goboBlur.height !== size) { goboBlur.width = size; goboBlur.height = size; }
    const b = goboBlur.getContext("2d");
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, size, size);
    b.shadowColor = "#ffffff";
    b.shadowBlur = blur * 2;            // 仕様上「ぼかし半径の2倍」
    b.shadowOffsetX = size;
    b.drawImage(goboSheet, -size, 0);
    return goboBlur;
  }
  /* 中心が (0,0)・半径 half＝単位1 の一時キャンバスに、模様と切る線を掛ける。
     ★楕円は BEAM_SOFT ぶん広げてあるので、切る線の距離と縁の幅もそのぶん縮める（照明モードと同じ）。 */
  function applyShapeToSheet(sheetCtx, size, half, pool, tMs) {
    const g = goboOf(pool);
    if (g) {
      const maskSheet = goboMaskSheet(g, size, half, goboAngleOf(pool, tMs), pool.goboSoft);
      if (maskSheet) {
        sheetCtx.globalCompositeOperation = "destination-in";
        sheetCtx.drawImage(maskSheet, -half, -half);
        sheetCtx.globalCompositeOperation = "source-over";
      }
    }
    const cuts = Array.isArray(pool.cuts) ? pool.cuts : [];
    cuts.forEach((cut) => {
      if (!cut || !Number.isFinite(cut.mx + cut.my + cut.d)) return;
      sheetCtx.save();
      sheetCtx.globalCompositeOperation = "destination-out";
      sheetCtx.rotate(Math.atan2(cut.my, cut.mx));
      const x0 = (cut.d / BEAM_SOFT) * half;
      const sw = Math.max(0.5, (finite(cut.soft, 0.04) / BEAM_SOFT) * half);
      const gradient = sheetCtx.createLinearGradient(x0 - sw, 0, x0 + sw, 0);
      gradient.addColorStop(0, "rgba(0,0,0,0)");
      gradient.addColorStop(1, "rgba(0,0,0,1)");
      sheetCtx.fillStyle = gradient;
      sheetCtx.fillRect(x0 - sw, -size, size * 2 + sw, size * 2);
      sheetCtx.restore();
    });
  }
  const hasShape = (pool) => Boolean(goboOf(pool) || (Array.isArray(pool.cuts) && pool.cuts.length));

  /* 光だまり1つ。返り値は描いたかどうか。
     ★楕円は「単位円をここへ写す行列」として扱う（照明モードと同じ）。
       中心と2本の半径ベクトルを投影するだけなので、遠近のある図でも1回の塗りで済む。 */
  function paintPool(ctx, pool, P, opts) {
    if (!pool || !pool.c || !pool.ea || !pool.eb) return false;
    const level = clamp(finite(pool.level, 0), 0, 100) / 100;
    if (!(level > 0)) return false;
    const centre = P(pool.c);
    const alongA = P(add(pool.c, pool.ea));
    const alongB = P(add(pool.c, pool.eb));
    if (!centre || !alongA || !alongB) return false;
    const ax = (alongA.X - centre.X) * BEAM_SOFT, ay = (alongA.Y - centre.Y) * BEAM_SOFT;
    const bx = (alongB.X - centre.X) * BEAM_SOFT, by = (alongB.Y - centre.Y) * BEAM_SOFT;
    if (!Number.isFinite(ax + ay + bx + by)) return false;
    if (Math.abs(ax * by - ay * bx) < MIN_AREA_PX) return false;

    const alpha = visualAlpha(level);
    const soft = clamp(finite(pool.softness, SOFT_DEFAULT), 0, 10);
    const core = 0.55 - soft * 0.018, edge = 0.94 - soft * 0.035;
    const paint = (gradient, colour) => {
      gradient.addColorStop(0, rgba(colour, ALPHA_CORE * alpha));
      gradient.addColorStop(core, rgba(colour, ALPHA_MID * alpha));
      gradient.addColorStop(edge, rgba(colour, ALPHA_EDGE * alpha));
      gradient.addColorStop(1, rgba(colour, 0));
      return gradient;
    };
    const fall = Array.isArray(pool.fall) && pool.fall.length > 2 ? pool.fall : null;
    /* 段階5: 模様（ゴボ）やカッターがある灯は、必ず一時キャンバスの道を通す（掛け算で形を作るため）。
       どちらも無い灯はこれまでどおり＝画素一致。 */
    const shaped = hasShape(pool);
    const tMs = opts && Number.isFinite(opts.tMs) ? opts.tMs : 0;

    ctx.save();
    // 暗い舞台の上で光が加算に見えるようにする（照明モードと同じ）
    ctx.globalCompositeOperation = "screen";
    ctx.transform(ax, ay, bx, by, centre.X, centre.Y);
    if (!fall && !shaped) {
      ctx.fillStyle = paint(ctx.createRadialGradient(0, 0, 0, 0, 0, 1), pool.color);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return true;
    }
    /* 長軸に沿った濃淡は掛け算なので、別のキャンバスで「光だまり×減衰」を作ってから1枚で載せる。
       一時キャンバスの横向きが楕円の長軸（左が灯体に近い側＝明るい）。照明モードと同じ作り。 */
    const radius = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
    const size = Math.min(shaped ? MAX_TEMP_PX : SMOOTH_POOL_TEMP_PX, Math.max(8, Math.ceil(radius * 2)));
    const sheet = tempCanvas(size);
    if (!sheet) {
      ctx.fillStyle = paint(ctx.createRadialGradient(0, 0, 0, 0, 0, 1), pool.color);
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return true;
    }
    const half = size / 2;
    const sheetCtx = sheet.getContext("2d");
    sheetCtx.setTransform(1, 0, 0, 1, 0, 0);
    sheetCtx.clearRect(0, 0, size, size);
    sheetCtx.save();
    sheetCtx.translate(half, half);
    sheetCtx.fillStyle = paint(sheetCtx.createRadialGradient(0, 0, 0, 0, 0, half), pool.color);
    sheetCtx.beginPath();
    sheetCtx.arc(0, 0, half, 0, Math.PI * 2);
    sheetCtx.fill();
    if (fall) {
      const shade = sheetCtx.createLinearGradient(-half, 0, half, 0);
      fall.forEach((step) => shade.addColorStop(
        clamp((finite(step.t, 0) + 1) / 2, 0, 1), `rgba(255,255,255,${clamp(finite(step.v, 0), 0, 1).toFixed(4)})`));
      sheetCtx.globalCompositeOperation = "destination-in";
      sheetCtx.fillStyle = shade;
      sheetCtx.fillRect(-half, -half, size, size);
      sheetCtx.globalCompositeOperation = "source-over";
    }
    if (shaped) applyShapeToSheet(sheetCtx, size, half, pool, tMs);
    sheetCtx.restore();
    // 一時キャンバスの半径 half が単位1にあたる
    ctx.drawImage(sheet, -1, -1, 2, 2);
    ctx.restore();
    return true;
  }

  /* まとめて塗る。返り値は実際に描けた数（帯の表示と計測に使う）。
     ★消えている灯・面の無い光（宙・客席）・レーザーは、呼ぶ側で除いてから渡す。 */
  function paintPools(ctx, pools, P, opts) {
    if (!Array.isArray(pools) || !pools.length) return 0;
    let drawn = 0;
    pools.forEach((pool) => { if (paintPool(ctx, pool, P, opts)) drawn += 1; });
    return drawn;
  }

  /* 光の帯（空気の中を進む筋）。段階2。
     ★三角の裾は「着地の楕円の短軸の両端」に着ける。短軸は光の進む向きと直角なので、
       どの図でも帯の幅と光だまりの幅が自然につながる（照明モードの corners と同じ位置）。
     ★真上から見る図では三角に開かない（2026-09-11 本人指定）。開き具合は床の光だまりの
       大きさとして既に出ているので、出どころと着地を結ぶ破線だけにする。 */
  /* 灯体からの距離で弱める生の形。t は 0＝灯体、1＝着地。 */
  const rawFall = (t) => 1 / Math.pow(1 + Math.max(0, t) / BEAM_FALL_R0, BEAM_FALL_P);

  /* 空気のむら（R-2）。**世界座標だけの関数**にすること。
     画面座標・カメラ・時刻を混ぜると、正面図・平面図・3Dカメラで模様が食い違う。
     値ノイズ（ハッシュ＋三線形補間＋smoothstep）。テーブルを持たない。 */
  function hash3(ix, iy, iz) {
    let n = (ix * 374761393 + iy * 1103515245 + iz * 668265263) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n = n ^ (n >>> 16);
    return (n >>> 0) / 4294967296;             // 0〜1
  }
  const smooth = (t) => t * t * (3 - 2 * t);
  function noise3(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const fx = smooth(x - ix), fy = smooth(y - iy), fz = smooth(z - iz);
    const lerp = (a, b, t) => a + (b - a) * t;
    const c00 = lerp(hash3(ix, iy, iz), hash3(ix + 1, iy, iz), fx);
    const c10 = lerp(hash3(ix, iy + 1, iz), hash3(ix + 1, iy + 1, iz), fx);
    const c01 = lerp(hash3(ix, iy, iz + 1), hash3(ix + 1, iy, iz + 1), fx);
    const c11 = lerp(hash3(ix, iy + 1, iz + 1), hash3(ix + 1, iy + 1, iz + 1), fx);
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz);
  }
  /* 倍率 1±amount。平均は 1＝筋の全体の明るさは変えず、むらだけ乗せる（中ほどの濃さを据え置く R-1 の作法と同じ）。 */
  function hazeAt(world, amount) {
    const amt = clamp(finite(amount, HAZE_AMOUNT), 0, 1);
    if (!(amt > 0) || !world) return 1;
    const n = noise3(finite(world.x, 0) / HAZE_SCALE_M, finite(world.y, 0) / HAZE_SCALE_M, finite(world.z, 0) / HAZE_SCALE_M);
    return 1 + amt * (2 * n - 1);
  }

  /* 筋の長さ方向の濃淡を「色止めの一覧」として返す。塗りとは分けてあるので、
     ブラウザが無い環境（node のテスト）でもここだけ検査できる。
     返り値: [{ t, at, v }]  t＝世界での位置(0〜1)、at＝画面の軸上の位置(0〜1)、v＝濃さの倍率。
     ★ at は **世界座標の点を投影してから** 画面の軸へ射影して決める。
       こうすると3Dカメラの遠近で「奥ほど色止めが詰まる」のが正しく出る。
       世界で等間隔の t は投影後は等間隔ではないので、画面上で等分してはいけない。 */
  function beamFalloff(pool, P, steps, haze) {
    if (!pool || !pool.from || !pool.c || typeof P !== "function") return null;
    const head = P(pool.from), tail = P(pool.c);
    if (!head || !tail) return null;
    const axX = tail.X - head.X, axY = tail.Y - head.Y;
    const len2 = axX * axX + axY * axY;
    if (!(len2 > 1e-6)) return null;
    const count = Math.max(2, Math.round(finite(steps, BEAM_FALL_STOPS)));
    const base = rawFall(BEAM_FALL_NORM_T);
    const out = [];
    for (let k = 0; k < count; k += 1) {
      const t = k / (count - 1);
      const world = {
        x: pool.from.x + (pool.c.x - pool.from.x) * t,
        y: pool.from.y + (pool.c.y - pool.from.y) * t,
        z: pool.from.z + (pool.c.z - pool.from.z) * t,
      };
      const at = P(world);
      if (!at) continue;                       // カメラの後ろへ回った点は飛ばす
      const along = ((at.X - head.X) * axX + (at.Y - head.Y) * axY) / len2;
      const fall = clamp(rawFall(t) / base, BEAM_FALL_LO, BEAM_FALL_HI);
      out.push({ t, at: clamp(along, 0, 1), v: clamp(fall * hazeAt(world, haze), 0, BEAM_FALL_HI) });
    }
    if (out.length < 2) return null;
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  /* 筋を横切る濃淡（扇形グラデーション）。塗る先の文脈を受け取るので、
     画面へ直に描くときも一時キャンバスへ描くときも同じ式が使える。 */
  /* 台形の筋の「仮想の頂点」＝両縁を延長して交わる点（レンズの後ろ）。扇形のグラデーションの中心を
     ここに置くと、等値線が台形の縁と平行になり、根元でもレンズの幅いっぱいが明るい。
     縁が平行（交点が無い）なら null＝平行のグラデーションへ。 */
  function beamApex(ends, cornerP, cornerM) {
    if (!ends) return null;
    const ax = ends.fromP.X, ay = ends.fromP.Y, bx = cornerP.X - ax, by = cornerP.Y - ay;
    const cx = ends.fromM.X, cy = ends.fromM.Y, dx = cornerM.X - cx, dy = cornerM.Y - cy;
    const den = bx * dy - by * dx;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((cx - ax) * dy - (cy - ay) * dx) / den;
    const apex = { X: ax + bx * t, Y: ay + by * t };
    return Number.isFinite(apex.X + apex.Y) ? apex : null;
  }

  function beamGradient(target, from, cornerP, cornerM, colour, alpha, softness, gain, apex) {
    const soft = clamp(finite(softness, SOFT_DEFAULT), 0, 10);
    const feather = 0.06 + soft * 0.035;
    const profile = [[0, 0], [feather * 0.45, 0.3], [feather, 1],
      [1 - feather, 1], [1 - feather * 0.45, 0.3], [1, 0]];
    const lift = Math.max(0, finite(gain, 1));
    /* 筋は灯体（点）から放射状に伸びる。扇形のグラデーションなら等値線が灯体から出る半直線になる。
       根元に幅があるときは中心を仮想の頂点（apex）に置く＝等値線が台形の縁に沿う。
       扇形が無い環境では平行のグラデーションへ戻す（見え方は近い）。 */
    const origin = apex || from;
    if (typeof target.createConicGradient === "function") {
      const TAU = Math.PI * 2;
      const wrap = (value) => ((value % TAU) + TAU) % TAU;
      const angleAt = (t) => Math.atan2(
        cornerM.Y + (cornerP.Y - cornerM.Y) * t - origin.Y,
        cornerM.X + (cornerP.X - cornerM.X) * t - origin.X);
      const left = angleAt(0), right = angleAt(1);
      const clockwise = wrap(right - left) <= Math.PI;
      const start = clockwise ? left : right;
      const sweep = clockwise ? wrap(right - left) : wrap(left - right);
      if (sweep > 1e-4) {
        const gradient = target.createConicGradient(start, origin.X, origin.Y);
        profile
          .map(([t, weight]) => [clamp(wrap(angleAt(t) - start) / TAU, 0, 1), weight])
          .sort((a, b) => a[0] - b[0])
          .forEach(([at, weight]) => gradient.addColorStop(
            at, rgba(colour, clamp(BAND_ALPHA * weight * alpha * lift, 0, 1))));
        return gradient;
      }
    }
    const gradient = target.createLinearGradient(cornerM.X, cornerM.Y, cornerP.X, cornerP.Y);
    profile.forEach(([at, weight]) => gradient.addColorStop(
      at, rgba(colour, clamp(BAND_ALPHA * weight * alpha * lift, 0, 1))));
    return gradient;
  }

  /* 正面図の光の筋は、投影後の光だまりへ接する2本の線で裾を決める。
     以前は楕円の短軸だけを裾に使っていたため、斜めから当てる灯では長軸の傾きが
     無視され、筋と光だまりが別々の場所へ向いて見えた。ここでは実際に paintPool が
     描く楕円（BEAM_SOFT を含む）へ、灯体の画面位置から引ける接線を解く。 */
  function beamLandingTangents(pool, P) {
    if (!pool || !pool.c || !pool.ea || !pool.eb || !pool.from || typeof P !== "function") return null;
    const from = P(pool.from), centre = P(pool.c);
    const alongA = P(add(pool.c, pool.ea)), alongB = P(add(pool.c, pool.eb));
    if (!from || !centre || !alongA || !alongB) return null;
    const ax = (alongA.X - centre.X) * BEAM_SOFT;
    const ay = (alongA.Y - centre.Y) * BEAM_SOFT;
    const bx = (alongB.X - centre.X) * BEAM_SOFT;
    const by = (alongB.Y - centre.Y) * BEAM_SOFT;
    if (![from.X, from.Y, centre.X, centre.Y, ax, ay, bx, by].every(Number.isFinite)) return null;
    const dx = centre.X - from.X, dy = centre.Y - from.Y;
    const cross = (x1, y1, x2, y2) => x1 * y2 - y1 * x2;
    const u = cross(dx, dy, bx, by);
    const v = -cross(dx, dy, ax, ay);
    const w = cross(ax, ay, bx, by);
    const radius = Math.hypot(u, v);
    if (!(radius > 1e-6) || Math.abs(w) >= radius - 1e-6) return null;
    const base = Math.atan2(v, u);
    const spread = Math.acos(clamp(-w / radius, -1, 1));
    const pointAt = (angle) => ({
      X: centre.X + ax * Math.cos(angle) + bx * Math.sin(angle),
      Y: centre.Y + ay * Math.cos(angle) + by * Math.sin(angle),
    });
    const cornerP = pointAt(base + spread);
    const cornerM = pointAt(base - spread);
    if (Math.hypot(cornerP.X - cornerM.X, cornerP.Y - cornerM.Y) < 1) return null;
    return { from, centre, cornerP, cornerM, ax, ay, bx, by };
  }

  /* 一時キャンバス上の帯だけを薄くする。斜めの底辺でも灯体→左右の接点を
     それぞれ0→1に写し、底辺全体のαを0にする。主キャンバスの床は消さない。 */
  function fadeBeamLanding(target, from, cornerP, cornerM, start = BEAM_LANDING_FADE_START) {
    const sideX = (cornerP.X - cornerM.X) / 2, sideY = (cornerP.Y - cornerM.Y) / 2;
    const axisX = (cornerP.X + cornerM.X) / 2 - from.X;
    const axisY = (cornerP.Y + cornerM.Y) / 2 - from.Y;
    if (Math.abs(sideX * axisY - sideY * axisX) < 1e-6) return false;
    target.save();
    target.globalCompositeOperation = "destination-in";
    target.transform(sideX, sideY, axisX, axisY, from.X, from.Y);
    const fade = target.createLinearGradient(0, 0, 0, 1);
    fade.addColorStop(0, "#fff");
    fade.addColorStop(start, "#fff");
    fade.addColorStop(1, "rgba(255,255,255,0)");
    target.fillStyle = fade;
    target.fillRect(-1, 0, 2, 1);
    target.restore();
    return true;
  }

  function paintBeam(ctx, pool, P, opts) {
    if (!pool || !pool.c || !pool.ea || !pool.eb || !pool.from) return false;
    const level = clamp(finite(pool.level, 0), 0, 100) / 100;
    if (!(level > 0)) return false;
    const from = P(pool.from);
    const centre = P(pool.c);
    if (!from || !centre) return false;
    const span = Math.hypot(centre.X - from.X, centre.Y - from.Y);
    const alpha = visualAlpha(level);
    /* 根元の幅（2026-09-27 実験室・本人要望「光の広がりは機材の幅から」）。pool.rootR（m）があれば、
       筋は点でなくレンズ口径の幅から始まる台形になる。無ければ従来どおり点から開く三角。 */
    const rootHalf = (() => {
      const rootR = finite(pool.rootR, 0); if (!(rootR > 0)) return 0;
      const q1 = P({ x: pool.from.x + 1, y: pool.from.y, z: pool.from.z });
      const pxPerM = q1 ? Math.hypot(q1.X - from.X, q1.Y - from.Y) : 0;
      return rootR * pxPerM;
    })();
    const rootEnds = (cornerP, cornerM) => {
      if (!(rootHalf > 0.5)) return null;
      const dx = centre.X - from.X, dy = centre.Y - from.Y, len = Math.hypot(dx, dy) || 1;
      let nx = -dy / len * rootHalf, ny = dx / len * rootHalf;
      if (cornerP && ((cornerP.X - centre.X) * nx + (cornerP.Y - centre.Y) * ny) < 0) { nx = -nx; ny = -ny; }
      return { fromP: { X: from.X + nx, Y: from.Y + ny }, fromM: { X: from.X - nx, Y: from.Y - ny } };
    };

    if (opts && opts.topDown) {
      if (!(span > LINE_MIN_PX)) return false;
      /* 根元の幅を持つ光（灯体の形がある新しい pool）は、上から見る図では筋を描かない＝光だまりだけ
         （2026-09-27 本人「平面図は光だまりだけでOK」）。根元の幅が無い旧来の pool は従来どおり破線。 */
      if (rootHalf > 0.5) return false;
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.strokeStyle = rgba(pool.color, LINE_ALPHA * alpha);
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(from.X, from.Y);
      ctx.lineTo(centre.X, centre.Y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return true;
    }

    if (!(span > BAND_MIN_PX)) return false;
    const landing = beamLandingTangents(pool, P);
    let cornerP = landing && landing.cornerP;
    let cornerM = landing && landing.cornerM;
    if (landing && Array.isArray(pool.cuts) && pool.cuts.length && root.RIG_ENGINE && root.RIG_ENGINE.beamLandingSilhouette) {
      const cutLanding = root.RIG_ENGINE.beamLandingSilhouette(landing.from,
        { cx: landing.centre.X, cy: landing.centre.Y, ax: landing.ax, ay: landing.ay, bx: landing.bx, by: landing.by },
        pool.cuts.map((cut) => ({ mx: cut.mx, my: cut.my, d: cut.d / BEAM_SOFT,
          soft: finite(cut.soft, 0.04) / BEAM_SOFT })));
      if (cutLanding) { cornerP = cutLanding.cornerP; cornerM = cutLanding.cornerM; }
    }
    /* 極端に広い光で灯体の投影が楕円内へ入ると接線は存在しない。その場合まで筋を
       消さないよう、従来の短軸端へだけ戻す（通常の灯は上の接線経路を通る）。 */
    if (!cornerP || !cornerM) {
      const alongB = P(add(pool.c, pool.eb));
      if (!alongB) return false;
      const bx = (alongB.X - centre.X) * BEAM_SOFT, by = (alongB.Y - centre.Y) * BEAM_SOFT;
      if (!Number.isFinite(bx + by) || Math.hypot(bx, by) < 1) return false;
      cornerP = { X: centre.X + bx, Y: centre.Y + by };
      cornerM = { X: centre.X - bx, Y: centre.Y - by };
    }

    /* 長さ方向の濃淡（灯体に近いほど明るい）。
       ★掛け算なので、光だまりと同じく**別のキャンバスで「横断 × 長さ」を作ってから1枚で載せる**。
         destination-in はαを減らすことしかできないので、三角形の側を BEAM_FALL_HI 倍だけ濃く塗り、
         色止めを HI で割って 0〜1 に収める。掛け合わせると元の濃さ × 倍率に戻る。 */
    const stops = beamFalloff(pool, P, BEAM_FALL_STOPS, opts && opts.haze);   // opts.haze＝むらの振れ幅（hazeAmount で写した値）
    const ends = rootEnds(cornerP, cornerM);
    /* 保持したシートがあれば貼るだけ。無ければ作り、鍵を2回見たときだけ保存する。 */
    let cacheKey = null;
    if (stops && typeof document !== "undefined" && ctx.canvas) {
      const geometry = beamSheetGeometry(ctx, from, cornerP, cornerM, ends ? [ends.fromP, ends.fromM] : null);
      if (geometry) {
        const key = beamCacheKey(ctx, from, centre, cornerP, cornerM, ends, pool, alpha, stops);
        const hit = beamCacheGet(key);
        if (hit) {
          ctx.save();
          ctx.globalCompositeOperation = "screen";
          ctx.drawImage(hit.canvas, 0, 0, hit.pw, hit.ph, hit.x0, hit.y0, hit.w, hit.h);
          ctx.restore();
          if (ends) paintRootGlow(ctx, pool, from, centre, ends, cornerP, cornerM, alpha, beamApex(ends, cornerP, cornerM));
          return true;
        }
        if (beamCacheSeenBefore(key)) cacheKey = key;
      }
    }
    const sheet = stops ? beamSheetFor(ctx, from, cornerP, cornerM, ends ? [ends.fromP, ends.fromM] : null) : null;

    if (!sheet) {
      /* ブラウザが無い／画面の外／一時キャンバスを作れないときは、長さ方向を掛けずにそのまま塗る
         （2026-09-18 までの見え方と同じ）。黙って落ちるより、薄くても筋が出るほうがよい。 */
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = beamGradient(ctx, from, cornerP, cornerM, pool.color, alpha, pool.softness, 1);
      const e0 = rootEnds(cornerP, cornerM);
      ctx.fillStyle = beamGradient(ctx, from, cornerP, cornerM, pool.color, alpha, pool.softness, 1, beamApex(e0, cornerP, cornerM));
      ctx.beginPath();
      if (e0) { ctx.moveTo(e0.fromP.X, e0.fromP.Y); ctx.lineTo(cornerP.X, cornerP.Y); ctx.lineTo(cornerM.X, cornerM.Y); ctx.lineTo(e0.fromM.X, e0.fromM.Y); }
      else { ctx.moveTo(from.X, from.Y); ctx.lineTo(cornerP.X, cornerP.Y); ctx.lineTo(cornerM.X, cornerM.Y); }   // 灯体は点。点から広がる三角なら捻れない
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      if (e0) paintRootGlow(ctx, pool, from, centre, e0, cornerP, cornerM, alpha, beamApex(e0, cornerP, cornerM));
      return true;
    }

    const { canvas, ctx: sheetCtx, x0, y0, w, h, pw, ph, sx, sy } = sheet;
    sheetCtx.setTransform(1, 0, 0, 1, 0, 0);
    sheetCtx.clearRect(0, 0, pw, ph);
    sheetCtx.setTransform(sx, 0, 0, sy, -x0 * sx, -y0 * sy);   // 以降は本体と同じ座標系のまま書ける
    sheetCtx.fillStyle = beamGradient(
      sheetCtx, from, cornerP, cornerM, pool.color, alpha, pool.softness, BEAM_FALL_HI, beamApex(ends, cornerP, cornerM));
    sheetCtx.beginPath();
    if (ends) { sheetCtx.moveTo(ends.fromP.X, ends.fromP.Y); sheetCtx.lineTo(cornerP.X, cornerP.Y); sheetCtx.lineTo(cornerM.X, cornerM.Y); sheetCtx.lineTo(ends.fromM.X, ends.fromM.Y); }
    else { sheetCtx.moveTo(from.X, from.Y); sheetCtx.lineTo(cornerP.X, cornerP.Y); sheetCtx.lineTo(cornerM.X, cornerM.Y); }
    sheetCtx.closePath();
    sheetCtx.fill();

    const shade = sheetCtx.createLinearGradient(from.X, from.Y, centre.X, centre.Y);
    let last = -1;
    stops.forEach((step) => {
      const at = step.at <= last ? Math.min(1, last + 1e-4) : step.at;  // 同じ位置は重ねられない
      last = at;
      shade.addColorStop(clamp(at, 0, 1), `rgba(255,255,255,${clamp(step.v / BEAM_FALL_HI, 0, 1).toFixed(4)})`);
    });
    sheetCtx.globalCompositeOperation = "destination-in";
    sheetCtx.fillStyle = shade;
    sheetCtx.fillRect(x0, y0, w, h);
    sheetCtx.globalCompositeOperation = "source-over";
    fadeBeamLanding(sheetCtx, from, cornerP, cornerM);
    sheetCtx.setTransform(1, 0, 0, 1, 0, 0);
    if (cacheKey) beamCachePut(cacheKey, canvas, { pw, ph, x0, y0, w, h });

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(canvas, 0, 0, pw, ph, x0, y0, w, h);
    ctx.restore();
    if (ends) paintRootGlow(ctx, pool, from, centre, ends, cornerP, cornerM, alpha, beamApex(ends, cornerP, cornerM));
    return true;
  }

  /* 光の出だし（根元）の明るい芯。筋と同じ台形の中だけに、レンズから ROOT_FRAC までで消える光を足す。
     形は筋そのもの＝縁が2本にならない。 */
  const ROOT_FRAC = 0.38;
  const ROOT_GAIN = 1.1;
  /* 芯は本体の筋と**同じ横断面**（同じ扇形グラデーション・同じ縁のぼけ）で作り、長さ方向だけ根元に寄せる。
     別の断面で重ねると「2つの光が層になった」ように見える（2026-09-27 本人指摘）。 */
  function paintRootGlow(ctx, pool, from, centre, ends, cornerP, cornerM, alpha, apex) {
    if (!(alpha > 0) || !ends) return;
    const sheet = beamSheetFor(ctx, from, cornerP, cornerM, [ends.fromP, ends.fromM], rootGlowBounds(from, centre, ends, cornerP, cornerM));
    if (!sheet) return;
    const { canvas, ctx: sc, x0, y0, w, h, pw, ph, sx, sy } = sheet;
    sc.setTransform(1, 0, 0, 1, 0, 0); sc.clearRect(0, 0, pw, ph); sc.setTransform(sx, 0, 0, sy, -x0 * sx, -y0 * sy);
    sc.fillStyle = beamGradient(sc, from, cornerP, cornerM, pool.color, alpha, pool.softness, ROOT_GAIN, apex);
    sc.beginPath(); sc.moveTo(ends.fromP.X, ends.fromP.Y); sc.lineTo(cornerP.X, cornerP.Y); sc.lineTo(cornerM.X, cornerM.Y); sc.lineTo(ends.fromM.X, ends.fromM.Y); sc.closePath(); sc.fill();
    const shade = sc.createLinearGradient(from.X, from.Y, centre.X, centre.Y);
    shade.addColorStop(0, "rgba(255,255,255,0.9)"); shade.addColorStop(ROOT_FRAC * 0.4, "rgba(255,255,255,0.4)"); shade.addColorStop(ROOT_FRAC, "rgba(255,255,255,0)"); shade.addColorStop(1, "rgba(255,255,255,0)");
    sc.globalCompositeOperation = "destination-in"; sc.fillStyle = shade; sc.fillRect(x0, y0, w, h);
    sc.globalCompositeOperation = "source-over"; sc.setTransform(1, 0, 0, 1, 0, 0);
    ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.drawImage(canvas, 0, 0, pw, ph, x0, y0, w, h); ctx.restore();
  }

  /* 根元の芯が実際に光る範囲の点（2026-10-05・v0.2.95）。芯は筋と同じ扇形を塗ってから、灯体→着地の中心の向きに
     ROOT_FRAC まででゼロになる濃淡（destination-in）を掛ける。ROOT_FRAC より先は完全に透明なので、一時キャンバスは
     扇形のうち「その向きの位置が ROOT_FRAC 以下」の部分だけの外接矩形で足りる（以前は筋の全体＝F-1 の2倍密度で 3.6Mpx）。
     扇形（ends.fromP→cornerP→cornerM→ends.fromM）を半平面で切った多角形の頂点を返す。作れなければ null（従来どおり全体）。 */
  function rootGlowBounds(from, centre, ends, cornerP, cornerM) {
    if (!from || !centre || !ends || !ends.fromP || !ends.fromM) return null;
    const dx = centre.X - from.X, dy = centre.Y - from.Y, len2 = dx * dx + dy * dy;
    if (!(len2 > 1e-6)) return null;
    const tOf = (q) => ((q.X - from.X) * dx + (q.Y - from.Y) * dy) / len2;
    const limit = ROOT_FRAC;
    const poly = [ends.fromP, cornerP, cornerM, ends.fromM];
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const ta = tOf(a), tb = tOf(b), ina = ta <= limit, inb = tb <= limit;
      if (ina) out.push(a);
      if (ina !== inb && Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
        const u = (limit - ta) / (tb - ta);
        out.push({ X: a.X + (b.X - a.X) * u, Y: a.Y + (b.Y - a.Y) * u });
      }
    }
    return out.length >= 3 && out.every((q) => Number.isFinite(q.X + q.Y)) ? out.concat([from]) : null;
  }

  /* 筋を描くぶんだけの一時キャンバスを用意する。画面の外は切り落とす（塗る面積＝重さなので）。 */
  /* ★画面の枠は「裏の画素数」ではなく「いまの座標系」で測る（2026-09-19・試験場 F-1 の実画面で発見）。
       本体は論理座標 W×H のまま setTransform(倍率) で裏の画素数に合わせている（BACKING_MIN_SCALE=0.5 なら
       裏は論理の半分）。裏の画素数で切ると、論理座標で右半分・下半分にある筋が丸ごと消えた。
       一時キャンバスの画素も裏の密度で持つ（縮小表示で無駄に細かくならず、拡大表示でぼやけない）。 */
  function canvasBoxInUserSpace(ctx, cw, ch) {
    let m = null;
    try { m = typeof ctx.getTransform === "function" ? ctx.getTransform() : null; } catch (_) { m = null; }
    const identity = !m || (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0);
    if (identity) return { x0: 0, y0: 0, x1: cw, y1: ch, sx: 1, sy: 1 };
    const inv = typeof m.inverse === "function" ? m.inverse() : null;
    if (!inv) return { x0: 0, y0: 0, x1: cw, y1: ch, sx: 1, sy: 1 };
    const corners = [[0, 0], [cw, 0], [0, ch], [cw, ch]]
      .map(([x, y]) => ({ X: inv.a * x + inv.c * y + inv.e, Y: inv.b * x + inv.d * y + inv.f }));
    const xs = corners.map((c) => c.X), ys = corners.map((c) => c.Y);
    if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return { x0: 0, y0: 0, x1: cw, y1: ch, sx: 1, sy: 1 };
    return {
      x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys),
      sx: Math.max(1e-3, Math.hypot(m.a, m.b)), sy: Math.max(1e-3, Math.hypot(m.c, m.d)),
    };
  }

  /* bounds を渡すと、外接矩形の元になる点をそれに置き換える（根元の芯が光る範囲だけにする）。 */
  function beamSheetGeometry(ctx, from, cornerP, cornerM, extra, bounds) {
    const target = ctx && ctx.canvas;
    const cw = target ? finite(target.width, 0) : 0;
    const ch = target ? finite(target.height, 0) : 0;
    if (!(cw > 0 && ch > 0)) return null;
    const pts = Array.isArray(bounds) && bounds.length ? bounds : [from, cornerP, cornerM].concat(Array.isArray(extra) ? extra : []);
    const xs = pts.map((q) => q.X), ys = pts.map((q) => q.Y);
    if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) return null;
    const box = canvasBoxInUserSpace(ctx, cw, ch);
    const x0 = Math.max(Math.floor(box.x0), Math.floor(Math.min(...xs)) - 2);
    const y0 = Math.max(Math.floor(box.y0), Math.floor(Math.min(...ys)) - 2);
    const x1 = Math.min(Math.ceil(box.x1), Math.ceil(Math.max(...xs)) + 2);
    const y1 = Math.min(Math.ceil(box.y1), Math.ceil(Math.max(...ys)) + 2);
    const w = x1 - x0, h = y1 - y0;
    if (!(w > 1 && h > 1)) return null;          // 画面の外＝描くものが無い
    /* 一時キャンバスの画素数は光だまりの temp と同じ上限（MAX_TEMP_PX）に収める。裏が3倍（BACKING_MAX_SCALE）で
       画面いっぱいの筋だと 3840px 幅の塗りになり、灯数ぶん重なる。筋は縁が柔らかいので少し粗くても見え方は変わらない。 */
    const shrink = Math.min(1, MAX_TEMP_PX / Math.max(1, w * box.sx, h * box.sy));
    const sx = box.sx * shrink, sy = box.sy * shrink;
    const pw = Math.max(1, Math.ceil(w * sx)), ph = Math.max(1, Math.ceil(h * sy));
    return { x0, y0, w, h, pw, ph, sx, sy };
  }

  function beamSheetFor(ctx, from, cornerP, cornerM, extra, bounds) {
    const g = beamSheetGeometry(ctx, from, cornerP, cornerM, extra, bounds);
    if (!g) return null;
    const canvas = beamCanvas(g.pw, g.ph);
    if (!canvas) return null;
    const sheetCtx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!sheetCtx) return null;
    return { canvas, ctx: sheetCtx, ...g };
  }

  /* --- 筋のシートの保持（上の BEAM_CACHE_* の説明を参照） --- */
  const beamCache = new Map();      // 鍵 → { canvas, pw, ph, x0, y0, w, h }（Map の順序＝使った順）
  const beamPending = new Set();    // 一度見た鍵（2回目に保存する）
  let beamCachePx = 0;
  const q64 = (n) => Math.round(n * 64);
  function beamCacheKey(ctx, from, centre, cornerP, cornerM, ends, pool, alpha, stops) {
    let m = "";
    try { const t = typeof ctx.getTransform === "function" ? ctx.getTransform() : null; if (t) m = [t.a, t.b, t.c, t.d, t.e, t.f].map((x) => Math.round(x * 1000)).join(","); } catch (_) { m = ""; }
    return [q64(from.X), q64(from.Y), q64(centre.X), q64(centre.Y), q64(cornerP.X), q64(cornerP.Y), q64(cornerM.X), q64(cornerM.Y),
      ends ? [ends.fromP.X, ends.fromP.Y, ends.fromM.X, ends.fromM.Y].map(q64).join(",") : "-",
      String(pool.color), Math.round(alpha * 1e4), finite(pool.softness, SOFT_DEFAULT),
      ctx.canvas.width, ctx.canvas.height, m,
      stops.map((st) => Math.round(st.at * 1e4) + ":" + Math.round(st.v * 1e3)).join(";")].join("|");
  }
  function beamCacheGet(key) {
    const hit = beamCache.get(key);
    if (hit) { beamCache.delete(key); beamCache.set(key, hit); }
    return hit || null;
  }
  function beamCacheRelease(entry) {
    beamCachePx -= entry.pw * entry.ph;
    entry.canvas.width = 0; entry.canvas.height = 0;     // Safari の canvas メモリを返す
  }
  function beamCacheSeenBefore(key) {
    if (beamPending.delete(key)) return true;
    if (beamPending.size >= BEAM_CACHE_PENDING_MAX) beamPending.clear();
    beamPending.add(key);
    return false;
  }
  function beamCachePut(key, source, g) {
    if (typeof document === "undefined" || g.pw * g.ph > BEAM_CACHE_MAX_PX) return;
    const canvas = document.createElement("canvas");
    canvas.width = g.pw; canvas.height = g.ph;
    const cx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!cx) return;
    cx.drawImage(source, 0, 0);
    beamCache.set(key, { canvas, pw: g.pw, ph: g.ph, x0: g.x0, y0: g.y0, w: g.w, h: g.h });
    beamCachePx += g.pw * g.ph;
    while (beamCachePx > BEAM_CACHE_MAX_PX && beamCache.size) {
      const oldest = beamCache.keys().next().value;
      beamCacheRelease(beamCache.get(oldest)); beamCache.delete(oldest);
    }
  }
  function clearBeamCache() { beamCache.forEach(beamCacheRelease); beamCache.clear(); beamPending.clear(); beamCachePx = 0; }
  function beamCacheStats() { return { entries: beamCache.size, px: beamCachePx, pending: beamPending.size }; }

  function paintBeams(ctx, pools, P, opts) {
    if (!Array.isArray(pools) || !pools.length) return 0;
    let drawn = 0;
    pools.forEach((pool) => { if (paintBeam(ctx, pool, P, opts)) drawn += 1; });
    return drawn;
  }

  /* 作業灯を消す（段階2b）。光の当たっていない所を暗くする。
     ★やり方は照明モードと同じ。別のキャンバスに地の暗さを敷き、**実際に見えている光と同じ形**で
       穴を開けてから、1枚重ねる。穴を別に作ると、光の外側にもう1枚薄い形が見えてしまう
       （2026-09-13 本人指摘）。
     ★灯の強さぶんだけ暗幕を剥がす。20%の灯なら20%ぶんしか明るくならない。 */
  function punchHole(maskCtx, pool, P, opts) {
    const level = clamp(finite(pool && pool.level, 0), 0, 100) / 100;
    if (!(level > 0) || !pool || !pool.c || !pool.ea || !pool.eb) return;
    const centre = P(pool.c);
    const alongA = P(add(pool.c, pool.ea));
    const alongB = P(add(pool.c, pool.eb));
    if (!centre || !alongA || !alongB) return;
    const ax = (alongA.X - centre.X) * BEAM_SOFT, ay = (alongA.Y - centre.Y) * BEAM_SOFT;
    const bx = (alongB.X - centre.X) * BEAM_SOFT, by = (alongB.Y - centre.Y) * BEAM_SOFT;
    if (!Number.isFinite(ax + ay + bx + by)) return;

    /* ★穴を開けるのは「面」だけ。空中の光（帯）では開けない。
       帯は物ではないので、画面の上で大道具を横切っただけの所まで明るく抜けてしまい、
       箱に光の形の切れ込みが入ったように見える（2026-09-18・3Dカメラで実際に出た）。
       帯は暗幕の**上から**足し算で描くので、穴を開けなくても光って見える。
       例外は真上から見る図。そこで見えているのは細い破線だけなので、その太さで抜く。 */
    const from = opts && opts.topDown && pool.from ? P(pool.from) : null;
    if (from) {
      const dx = centre.X - from.X, dy = centre.Y - from.Y, len = Math.hypot(dx, dy) || 1;
      const nx = (-dy / len) * HOLE_LINE_PX, ny = (dx / len) * HOLE_LINE_PX;
      maskCtx.beginPath();
      maskCtx.moveTo(from.X + nx, from.Y + ny);
      maskCtx.lineTo(centre.X + nx, centre.Y + ny);
      maskCtx.lineTo(centre.X - nx, centre.Y - ny);
      maskCtx.lineTo(from.X - nx, from.Y - ny);
      maskCtx.closePath();
      maskCtx.fillStyle = `rgba(255,255,255,${HOLE_BAND * level})`;
      maskCtx.fill();
    }

    if (Math.abs(ax * by - ay * bx) < MIN_AREA_PX) return;
    maskCtx.save();
    maskCtx.transform(ax, ay, bx, by, centre.X, centre.Y);
    /* 段階5: 模様・カッターのある灯は、穴も同じ形にする（丸い穴だと暗幕の中で模様が消える）。
       穴を一時キャンバスで作って（丸×模様×切る線）、それを暗幕から抜く。 */
    if (hasShape(pool)) {
      const radius = Math.max(Math.hypot(ax, ay), Math.hypot(bx, by));
      const size = Math.min(MAX_TEMP_PX, Math.max(8, Math.ceil(radius * 2)));
      const sheet = tempCanvas(size);
      if (sheet) {
        const half = size / 2;
        const sheetCtx = sheet.getContext("2d");
        sheetCtx.setTransform(1, 0, 0, 1, 0, 0);
        sheetCtx.clearRect(0, 0, size, size);
        sheetCtx.save();
        sheetCtx.translate(half, half);
        const holeShape = sheetCtx.createRadialGradient(0, 0, 0, 0, 0, half);
        holeShape.addColorStop(0, `rgba(255,255,255,${level})`);
        holeShape.addColorStop(0.75, `rgba(255,255,255,${0.9 * level})`);
        holeShape.addColorStop(1, "rgba(255,255,255,0)");
        sheetCtx.fillStyle = holeShape;
        sheetCtx.beginPath();
        sheetCtx.arc(0, 0, half, 0, Math.PI * 2);
        sheetCtx.fill();
        applyShapeToSheet(sheetCtx, size, half, pool, opts && Number.isFinite(opts.tMs) ? opts.tMs : 0);
        sheetCtx.restore();
        maskCtx.drawImage(sheet, -1, -1, 2, 2);
        maskCtx.restore();
        return;
      }
    }
    const hole = maskCtx.createRadialGradient(0, 0, 0, 0, 0, 1);
    hole.addColorStop(0, `rgba(255,255,255,${level})`);
    hole.addColorStop(0.75, `rgba(255,255,255,${0.9 * level})`);
    hole.addColorStop(1, "rgba(255,255,255,0)");
    maskCtx.fillStyle = hole;
    maskCtx.beginPath();
    maskCtx.arc(0, 0, 1, 0, Math.PI * 2);
    maskCtx.fill();
    maskCtx.restore();
  }

  /* 図の上へ暗幕を1枚重ねる。点いている光がひとつも無ければ、全体が暗くなる（それが正しい）。
     ★呼ぶ側は「演者や大道具を描いた後・名前や注記を描く前」に呼ぶ。
       名前まで暗くすると読めなくなる。 */
  function paintWorkLight(ctx, pools, P, opts) {
    const options = opts || {};
    const canvas = ctx && ctx.canvas;
    if (!canvas) return false;
    const sheet = maskCanvas(canvas.width, canvas.height);
    if (!sheet) return false;
    const dim = clamp(finite(options.dim, 1), 0, 1);
    const maskCtx = sheet.getContext("2d");
    maskCtx.setTransform(1, 0, 0, 1, 0, 0);
    maskCtx.clearRect(0, 0, sheet.width, sheet.height);
    maskCtx.globalCompositeOperation = "source-over";
    maskCtx.fillStyle = `rgba(${DARK},${dim})`;
    maskCtx.fillRect(0, 0, sheet.width, sheet.height);
    /* 図と同じ座標で穴を開けるため、いまの図の変換をそのまま写す。
       これで共有部品は拡大・縮小・傾きの中身を知らずに済む。 */
    if (typeof ctx.getTransform === "function") {
      const matrix = ctx.getTransform();
      maskCtx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
    }
    /* 光だまりは床の面の情報。正面図や側面図では、その投影が奥の背景と重なることがある。
       呼び側が床の輪郭を渡した場合だけ、穴をその面の中へ閉じ込める。
       暗幕そのものは画面全体へ敷くので、背景・壁・天井は暗く残る。 */
    let floorClipped = false;
    if (typeof options.floorClip === "function") {
      maskCtx.save();
      floorClipped = options.floorClip(maskCtx) !== false;
      if (!floorClipped) maskCtx.restore();
    }
    maskCtx.globalCompositeOperation = "destination-out";
    (Array.isArray(pools) ? pools : []).forEach((pool) => punchHole(maskCtx, pool, P, options));
    maskCtx.globalCompositeOperation = "source-over";
    if (floorClipped) maskCtx.restore();

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(sheet, 0, 0);
    ctx.restore();
    return true;
  }

  /* その場所に光が当たっているか。床の光だまり（楕円）の中に入っているかで決める。
     ★これで「暗幕の後に描き直す駒」を選ぶ。物の足元が光の輪に入っていれば、その物は光の中にいる。
     ★楕円の座標へ写してから長さを測る。marginM は物の大きさ（半径）のぶんの見逃しを防ぐ。
     ★高さは見ない。舞台の光は上から来るので、床で当たっていれば立っている物にも当たる。 */
  /* その点（足元）が光だまりの中なら強さ 0〜1、外なら 0。litLevelAt と litColorAt が共に使う */
  function poolLevelAt(pool, point, marginM) {
    if (!pool || !pool.c || !pool.ea || !pool.eb) return 0;
    const level = clamp(finite(pool.level, 0), 0, 100) / 100;
    if (!(level > 0)) return 0;
    const dx = finite(point.x, 0) - pool.c.x;
    const dy = finite(point.y, 0) - pool.c.y;
    const aLen = Math.hypot(pool.ea.x, pool.ea.y) || 1e-6;
    const bLen = Math.hypot(pool.eb.x, pool.eb.y) || 1e-6;
    const margin = Math.max(0, finite(marginM, 0));
    const along = (dx * pool.ea.x + dy * pool.ea.y) / (aLen * (aLen + margin));
    const across = (dx * pool.eb.x + dy * pool.eb.y) / (bLen * (bLen + margin));
    return along * along + across * across <= 1 ? level : 0;
  }
  function litLevelAt(pools, point, marginM) {
    if (!Array.isArray(pools) || !point) return 0;
    let best = 0;
    pools.forEach((pool) => { best = Math.max(best, poolLevelAt(pool, point, marginM)); });
    return best;
  }

  /* ---------- 衣装の色 × 明かりの色（G-D・2026-09-19・本人決定「人物を染める」） ----------
     設計: docs/costume-light-color-2026-09-19/index.html
     ★判定は足元1点（作業灯と同じ考え方＝光は上から来るので、足元に当たっていれば体にも当たる）。
     ★重なった光だまりの混ぜ方は**仮置き**: 強さで重みづけした色の平均（足し算にすると白く飛ぶ）。
       明るさはいちばん強い1つ。実物を見て決める（本人判断待ち）。
     ★見える色＝衣装の色 × 明かりの色。明るさは「作業灯を消す」の暗幕が既に表しているので、ここでは
       色だけを掛ける（強さは「どれだけ染まるか」に使う）。白い明かりなら色は変わらない。
     ★掛けきらない。回り込みの光ぶん COSTUME_AMBIENT を残す。掛けきると真っ黒になって図として読めない。 */
  const COSTUME_AMBIENT = 0.18;
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  function rgbToHex(rgb) {
    return "#" + rgb.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, "0")).join("");
  }
  function litColorAt(pools, point, marginM) {
    if (!Array.isArray(pools) || !point) return null;
    let best = 0, weight = 0;
    const mix = [0, 0, 0];
    pools.forEach((pool) => {
      const level = poolLevelAt(pool, point, marginM);
      if (!(level > 0)) return;
      const rgb = hexToRgb(pool.color) || [1, 1, 1];
      mix[0] += rgb[0] * level; mix[1] += rgb[1] * level; mix[2] += rgb[2] * level;
      weight += level;
      best = Math.max(best, level);
    });
    if (!(best > 0) || !(weight > 0)) return null;
    const rgb = mix.map((v) => clamp(v / weight, 0, 1));
    return { level: best, rgb, color: rgbToHex(rgb) };
  }
  function tintColor(base, lit, opts) {
    const rgb = hexToRgb(base);
    if (!rgb || !lit || !Array.isArray(lit.rgb)) return base;
    const level = clamp(finite(lit.level, 0), 0, 1);
    if (!(level > 0)) return base;
    const ambient = clamp(finite(opts && opts.ambient, COSTUME_AMBIENT), 0, 1);
    return rgbToHex(rgb.map((v, i) => {
      const full = ambient + (1 - ambient) * clamp(finite(lit.rgb[i], 1), 0, 1);   // 全力で染まったときの倍率
      return v * (1 - level * (1 - full));                                          // 強さぶんだけ染める
    }));
  }

  /* ---------- レーザー（2026-09-19・段階5①） ----------
     幾何（世界座標の光線）は overlay 側（gamma-light-cue-overlay.js）が組む。
     ここでは照明モードと同じ LASER_EFFECTS.drawProjected を呼ぶだけ（形の正本を2か所に持たない）。 */
  function paintLaser(ctx, laser, P) {
    const engine = root.LASER_EFFECTS || null;
    if (!engine || !laser || !Array.isArray(laser.rays) || !laser.rays.length) return false;
    const level = clamp(finite(laser.level, 0), 0, 100) / 100;
    if (!(level > 0)) return false;
    const spec = engine.EFFECTS[laser.effect] || engine.EFFECTS.fan;
    engine.drawProjected(ctx, P, laser.rays, laser.color, level, 100,
      { fill: Boolean(spec.fill), surface: Boolean(spec.surface) });
    return true;
  }
  function paintLasers(ctx, lasers, P) {
    if (!Array.isArray(lasers) || !lasers.length) return 0;
    let drawn = 0;
    lasers.forEach((laser) => { if (paintLaser(ctx, laser, P)) drawn += 1; });
    return drawn;
  }


  /* ---------- ミラーボール（2026-10-03・設計 docs/mirror-ball-plan-2026-10-03/DESIGN.md） ----------
     鏡片の法線 n、入射 d（ピン→鏡片）に対し反射 r = d − 2(d·n)n。鏡片の位置 F = C + R·n から r の向きへ進み、
     最初に当たる面（床 z=0／奥の壁 y=0／天井 z=H／袖 x=±W/2／客席側 y=D）に「粒」が落ちる。
     球の回転は n を鉛直軸(z)まわりに回すだけ（rpm → 1分で1周）。
     ★mirrorBallDotsAt は世界座標だけの純粋関数（canvas 不要・node で検査できる）。
     ★塗り（paintMirrorBalls）は 面×色×明るさ3段ごとに Path2D へ全部の粒を入れて1回 fill（lighter）。
       粒を1つずつ fill すると数百〜千回の合成になる。shadowBlur は使わない（Safari で重い・ctx.filter は無視される）。
     ★「mirror」の語は組の鏡映（mirrorMount 等）に既に使っているので、ここは必ず mirrorBall と書く。 */
  const MIRROR_BALL_FACETS = Object.freeze({ low: 240, mid: 600, high: 1500 });   // 鏡片の標本数（実物 φ300 は約2,800枚）
  const MIRROR_BALL_DOT_BASE_M = 0.012;     // 粒の半径の底（鏡片 10mm ＋ 少し）
  const MIRROR_BALL_DOT_SPREAD = 0.006;     // 1m 進むごとの広がり（≒0.7°・推測値。デモで見た目を確認した）
  const MIRROR_BALL_DOT_FALL_M = 7;         // 明るさが半分になる距離(m)
  const MIRROR_BALL_DOT_ALPHA = Object.freeze([0.9, 0.6, 0.3]);   // 明るさ3段
  const MIRROR_BALL_RAY_EVERY = 12;         // 筋は何粒に1本か
  const MIRROR_BALL_RAY_ALPHA = 0.08;
  const MIRROR_BALL_HALO = 2;               // 淡い輪の半径倍率
  const MIRROR_BALL_HANG_M = 0.3;           // バトンから球の天辺までの吊り代（モーター分）
  /* 球そのものの光り（2026-10-03・本人要望「ミラーボールそのものが反射で光るようにもしたい」）。
     ピンの光を各鏡片が反射し、その向きが「見ている方向」に近い鏡片だけが光る（鏡片の法線 n・入射 d・反射 r=d−2(d·n)n、
     視線 v に対し r·v ≥ cos σ）。球が回れば光る鏡片が入れ替わって瞬く。σ は実物（鏡片が点光源の像を返す）より広めにして、
     小さな絵でも瞬きが見えるようにした。 */
  const MIRROR_BALL_GLINT_SIGMA_DEG = 16;   // 反射の向きが視線からこの角度以内の鏡片が光る
  const MIRROR_BALL_GLINT_FACETS = 360;     // 体のきらめきに使う鏡片の標本数（小さい絵なので粒より少なくてよい）
  const MIRROR_BALL_GLINT_MAX = 28;         // 1つの球で描くきらめきの上限
  const mirrorBallFacetCache = new Map();
  const mbUnit = (v) => { const n = Math.hypot(v.x, v.y, v.z); return n > 1e-9 ? { x: v.x / n, y: v.y / n, z: v.z / n } : null; };
  /* 鏡片の法線＝フィボナッチ球（決定的・一様）。数ごとに1回だけ作って使い回す。 */
  function mirrorBallFacets(count) {
    const n = Math.max(12, Math.min(6000, Math.round(finite(count, MIRROR_BALL_FACETS.mid))));
    let list = mirrorBallFacetCache.get(n);
    if (list) return list;
    list = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i += 1) {
      const z = 1 - 2 * (i + 0.5) / n;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const a = golden * i;
      list.push({ x: r * Math.cos(a), y: r * Math.sin(a), z });
    }
    mirrorBallFacetCache.set(n, list);
    return list;
  }
  /* 粒の一覧（世界座標m）。
     ball = { centre:{x,y,z}, radiusM, rpm, phaseDeg, sources:[{ from:{x,y,z}, color:"#rrggbb", level:0..100, beamDeg }] }
     opts = { dims:{W,D,H}, facets, surfaces:{floor,back,ceil,side}, every }
     返り値 { dots:[{ P, F, on, b, rm, color, bin, ray }], counts:{floor,back,ceil,side,house} }
       P＝落ちた点・F＝鏡片の位置・on＝落ちた面・b＝明るさ(0..1)・rm＝粒の半径(m)・bin＝明るさ3段・ray＝筋を描く粒か */
  function mirrorBallDotsAt(ball, tMs, opts) {
    const o = opts || {};
    const dims = o.dims || {};
    const W = finite(dims.W, 12), D = finite(dims.D, 9), H = finite(dims.H, 8);
    const surfaces = o.surfaces || { floor: true, back: true };
    const out = { dots: [], counts: { floor: 0, back: 0, ceil: 0, side: 0, house: 0 } };
    const C = ball && ball.centre;
    if (!C || !Array.isArray(ball.sources) || !ball.sources.length) return out;
    const R = Math.max(0.05, finite(ball.radiusM, 0.15));
    const facets = mirrorBallFacets(o.facets);
    const every = Math.max(1, Math.round(finite(o.every, MIRROR_BALL_RAY_EVERY)));
    const ang = finite(ball.phaseDeg, 0) * Math.PI / 180
      + finite(ball.rpm, 0) * Math.PI * 2 / 60 * (finite(tMs, 0) / 1000);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    ball.sources.forEach((src) => {
      const S = src && src.from;
      const level = clamp(finite(src && src.level, 100), 0, 100) / 100;
      if (!S || !(level > 0)) return;
      const colour = typeof src.color === "string" && /^#[0-9a-f]{6}$/i.test(src.color) ? src.color : "#f2ead6";
      const toC = mbUnit({ x: C.x - S.x, y: C.y - S.y, z: C.z - S.z });
      if (!toC) return;
      const cosHalf = Math.cos(clamp(finite(src.beamDeg, 6), 1, 170) * Math.PI / 360);
      let k = 0;
      for (let i = 0; i < facets.length; i += 1) {
        const n0 = facets[i];
        const n = { x: n0.x * ca - n0.y * sa, y: n0.x * sa + n0.y * ca, z: n0.z };
        const F = { x: C.x + R * n.x, y: C.y + R * n.y, z: C.z + R * n.z };
        const d = mbUnit({ x: F.x - S.x, y: F.y - S.y, z: F.z - S.z });
        if (!d) continue;
        const dn = d.x * n.x + d.y * n.y + d.z * n.z;
        if (dn >= 0) continue;                                              // 光の当たらない裏側
        if (d.x * toC.x + d.y * toC.y + d.z * toC.z < cosHalf) continue;      // ピンの円錐の外
        const r = { x: d.x - 2 * dn * n.x, y: d.y - 2 * dn * n.y, z: d.z - 2 * dn * n.z };
        let t = Infinity, on = null;
        const hit = (tt, kind) => { if (tt > 1e-4 && tt < t) { t = tt; on = kind; } };
        if (r.z < -1e-9) hit((0 - F.z) / r.z, "floor");
        if (r.z > 1e-9) hit((H - F.z) / r.z, "ceil");
        if (r.y < -1e-9) hit((0 - F.y) / r.y, "back");
        if (r.y > 1e-9) hit((D - F.y) / r.y, "house");
        if (r.x < -1e-9) hit((-W / 2 - F.x) / r.x, "side");
        if (r.x > 1e-9) hit((W / 2 - F.x) / r.x, "side");
        if (!on) continue;
        out.counts[on] += 1;
        if (!surfaces[on]) continue;
        const P = { x: F.x + r.x * t, y: F.y + r.y * t, z: F.z + r.z * t };
        const b = level / (1 + (t / MIRROR_BALL_DOT_FALL_M) * (t / MIRROR_BALL_DOT_FALL_M));
        k += 1;
        out.dots.push({ P, F, on, b, rm: MIRROR_BALL_DOT_BASE_M + t * MIRROR_BALL_DOT_SPREAD, color: colour,
          bin: b > 0.55 ? 0 : b > 0.28 ? 1 : 2, ray: (k % every) === 0 });
      }
    });
    return out;
  }
  /* 球の体のきらめき（世界座標の純粋関数・canvas 不要）。
     ball は mirrorBallDotsAt と同じ。view = { eye:{x,y,z} } か { dir:{x,y,z} }（球から見ている側への向き）。
     返り値 { glints:[{ n:{x,y,z}, I:0..1, color, i }] }（I の大きい順・上限 MIRROR_BALL_GLINT_MAX）。
     光る条件: 視線側を向く鏡片（n·v>0.05）・ピン側を向く鏡片（d·n<0）・反射が視線に近い（r·v ≥ cos σ）。 */
  function mirrorBallGlintsAt(ball, tMs, view, opts) {
    const out = { glints: [] };
    const C = ball && ball.centre;
    if (!C || !Array.isArray(ball.sources) || !ball.sources.length) return out;
    const v = mirrorBallViewOf(C, view && { eye: view.eye, viewDir: view.dir });
    if (!v) return out;
    const o = opts || {};
    const R = Math.max(0.05, finite(ball.radiusM, 0.15));
    const facets = mirrorBallFacets(o.facets || MIRROR_BALL_GLINT_FACETS);
    const ang = finite(ball.phaseDeg, 0) * Math.PI / 180 + finite(ball.rpm, 0) * Math.PI * 2 / 60 * (finite(tMs, 0) / 1000);
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const cosSigma = Math.cos(clamp(finite(o.sigmaDeg, MIRROR_BALL_GLINT_SIGMA_DEG), 1, 60) * Math.PI / 180);
    ball.sources.forEach((src) => {
      const S = src && src.from;
      const level = clamp(finite(src && src.level, 100), 0, 100) / 100;
      if (!S || !(level > 0)) return;
      const colour = typeof src.color === "string" && /^#[0-9a-f]{6}$/i.test(src.color) ? src.color : "#f2ead6";
      for (let i = 0; i < facets.length; i += 1) {
        const n0 = facets[i];
        const n = { x: n0.x * ca - n0.y * sa, y: n0.x * sa + n0.y * ca, z: n0.z };
        const nv = n.x * v.x + n.y * v.y + n.z * v.z;
        if (nv <= 0.05) continue;                                             // 視線と反対側
        const d = mbUnit({ x: C.x + R * n.x - S.x, y: C.y + R * n.y - S.y, z: C.z + R * n.z - S.z });
        if (!d) continue;
        const dn = d.x * n.x + d.y * n.y + d.z * n.z;
        if (dn >= 0) continue;                                                // ピンの光が当たらない側
        const cosA = (d.x - 2 * dn * n.x) * v.x + (d.y - 2 * dn * n.y) * v.y + (d.z - 2 * dn * n.z) * v.z;
        if (cosA <= cosSigma) continue;                                       // 反射が視線から遠い
        const k = (cosA - cosSigma) / (1 - cosSigma);
        out.glints.push({ n, I: Math.min(1, Math.pow(k, 1.2) * level * (0.6 + 0.4 * nv)), color: colour, i });
      }
    });
    out.glints.sort((a, b) => b.I - a.I);
    if (out.glints.length > MIRROR_BALL_GLINT_MAX) out.glints.length = MIRROR_BALL_GLINT_MAX;
    return out;
  }
  /* 面の中の2軸（粒の足跡を画面へ写すため。床・天井は x/y、奥の壁は x/z、袖は y/z）。 */
  const MIRROR_BALL_AXES = Object.freeze({
    floor: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }], ceil: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
    back: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }], side: [{ x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: 1 }],
  });
  /* 見ている向き（球から見ている側への単位ベクトル）。eye か dir のどちらかから作る。 */
  function mirrorBallViewOf(C, o) {
    if (o && o.eye) return mbUnit({ x: o.eye.x - C.x, y: o.eye.y - C.y, z: o.eye.z - C.z });
    if (o && o.viewDir) return mbUnit(o.viewDir);
    return null;
  }
  /* 球の体。鏡片のタイル（回ると流れる）＋ピンの光を受けた側の明るさ＋やわらかい照り返し＋鏡片のきらめき。
     見る向き（o.eye / o.viewDir）が無いときは従来どおり、グラデーションの球と照り返しだけ。 */
  function paintMirrorBallBody(ctx, ball, P, opts) {
    const o = opts || {};
    const C = ball && ball.centre; if (!C) return false;
    const c = P(C); if (!c) return false;
    const R = Math.max(0.05, finite(ball.radiusM, 0.15));
    const e = P({ x: C.x + R, y: C.y, z: C.z });
    const e2 = P({ x: C.x, y: C.y, z: C.z + R });
    const rp = Math.max(2, Math.max(e ? Math.hypot(e.X - c.X, e.Y - c.Y) : 0, e2 ? Math.hypot(e2.X - c.X, e2.Y - c.Y) : 0));
    if (!Number.isFinite(rp) || rp > 600) return false;
    ctx.save();
    if (!o.topDown && ball.hangFrom) {
      const h = P(ball.hangFrom);
      if (h) { ctx.strokeStyle = "rgba(200,200,200,0.5)"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(c.X, c.Y - rp); ctx.lineTo(h.X, h.Y); ctx.stroke(); }
    }
    const v = mirrorBallViewOf(C, o);
    const lit = (ball.sources || []).filter((src) => src && src.from && clamp(finite(src.level, 100), 0, 100) > 0);
    const g = ctx.createRadialGradient(c.X - rp * 0.3, c.Y - rp * 0.3, rp * 0.1, c.X, c.Y, rp);
    if (v) { g.addColorStop(0, "#c9ccd2"); g.addColorStop(0.55, "#7d818a"); g.addColorStop(1, "#33363d"); }   // 鏡片を重ねるので、土台は少し暗め
    else { g.addColorStop(0, "#f4f4f4"); g.addColorStop(0.5, "#b9bcc3"); g.addColorStop(1, "#5b5f68"); }
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c.X, c.Y, rp, 0, Math.PI * 2); ctx.fill();
    ctx.globalCompositeOperation = "lighter";
    /* 鏡片のタイル: 視線側を向く鏡片を小さな点で並べる。ピンのほうを向く鏡片ほど明るい。球が回ると流れる。 */
    if (v && rp >= 3.5) {
      const facets = mirrorBallFacets(MIRROR_BALL_GLINT_FACETS);
      const ang = finite(ball.phaseDeg, 0) * Math.PI / 180 + finite(ball.rpm, 0) * Math.PI * 2 / 60 * (finite(o.tMs, 0) / 1000);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      let L = null;
      if (lit.length) { const acc = { x: 0, y: 0, z: 0 }; lit.forEach((src) => { const u = mbUnit({ x: src.from.x - C.x, y: src.from.y - C.y, z: src.from.z - C.z }); if (u) { const w = clamp(finite(src.level, 100), 0, 100) / 100; acc.x += u.x * w; acc.y += u.y * w; acc.z += u.z * w; } }); L = mbUnit(acc); }
      const bins = [new Path2D(), new Path2D(), new Path2D()], tile = Math.max(0.5, rp * 0.05);
      for (let i = 0; i < facets.length; i += 1) {
        const n0 = facets[i];
        const n = { x: n0.x * ca - n0.y * sa, y: n0.x * sa + n0.y * ca, z: n0.z };
        const nv = n.x * v.x + n.y * v.y + n.z * v.z; if (nv <= 0.02) continue;
        const q = P({ x: C.x + R * n.x, y: C.y + R * n.y, z: C.z + R * n.z }); if (!q) continue;
        const lam = L ? Math.max(0, n.x * L.x + n.y * L.y + n.z * L.z) : 0;
        const jit = ((Math.imul(i + 1, 2654435761) >>> 0) / 4294967296);          // 鏡片ごとの固定のばらつき
        const bright = 0.1 + 0.42 * lam + 0.3 * jit, r = tile * (0.65 + 0.35 * nv), bin = bins[bright > 0.55 ? 2 : bright > 0.32 ? 1 : 0];
        bin.moveTo(q.X + r, q.Y); bin.arc(q.X, q.Y, r, 0, Math.PI * 2);
      }
      [0.06, 0.14, 0.26].forEach((alpha, k) => { ctx.fillStyle = rgba("#ffffff", alpha); ctx.fill(bins[k]); });
    }
    /* ピンの光を受けているときの、球のまわりのにじみ（光っている印）。 */
    if (lit.length) {
      const lvSum = Math.min(1, lit.reduce((sum, src) => sum + clamp(finite(src.level, 100), 0, 100) / 100, 0));
      const tint = typeof lit[0].color === "string" ? lit[0].color : "#f2ead6", glowR = rp * 2.4;
      const glow = ctx.createRadialGradient(c.X, c.Y, rp * 0.6, c.X, c.Y, glowR);
      glow.addColorStop(0, rgba(tint, 0.2 * lvSum)); glow.addColorStop(1, rgba(tint, 0));
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(c.X, c.Y, glowR, 0, Math.PI * 2); ctx.fill();
    }
    /* 鏡片のきらめき: 反射が見ている方向に合った鏡片だけが光る。回れば入れ替わって瞬く。 */
    if (v) {
      const gl = mirrorBallGlintsAt(ball, o.tMs, { eye: o.eye, dir: o.viewDir });
      gl.glints.forEach((gk) => {
        const q = P({ x: C.x + R * gk.n.x, y: C.y + R * gk.n.y, z: C.z + R * gk.n.z }); if (!q) return;
        const size = Math.max(0.8, rp * (0.06 + 0.09 * gk.I));
        ctx.fillStyle = rgba(gk.color, 0.3 * gk.I); ctx.beginPath(); ctx.arc(q.X, q.Y, size * 2.6, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = rgba("#ffffff", 0.4 + 0.6 * gk.I); ctx.beginPath(); ctx.arc(q.X, q.Y, size, 0, Math.PI * 2); ctx.fill();
        if (gk.I > 0.45 && rp >= 5) {        // 強い光は短い十字（きらっとした見え方・球からはみ出しすぎない）
          const len = rp * (0.28 + 0.5 * gk.I); ctx.strokeStyle = rgba("#ffffff", 0.55 * gk.I); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(q.X - len, q.Y); ctx.lineTo(q.X + len, q.Y); ctx.moveTo(q.X, q.Y - len); ctx.lineTo(q.X, q.Y + len); ctx.stroke();
        }
      });
    }
    /* ピン側のやわらかい照り返し（硬い円を重ねると白い塊になるので、放射グラデーションで）。 */
    lit.forEach((src) => {
      const s = P(src.from); if (!s) return;
      const lv = clamp(finite(src.level, 100), 0, 100) / 100;
      const dx = s.X - c.X, dy = s.Y - c.Y, L = Math.hypot(dx, dy) || 1, x = c.X + dx / L * rp * 0.5, y = c.Y + dy / L * rp * 0.5, r = Math.max(1.5, rp * 0.32);
      const sp = ctx.createRadialGradient(x, y, 0, x, y, r);
      sp.addColorStop(0, rgba(typeof src.color === "string" ? src.color : "#f2ead6", 0.42 * lv)); sp.addColorStop(1, rgba(typeof src.color === "string" ? src.color : "#f2ead6", 0));
      ctx.fillStyle = sp; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    });
    ctx.restore();
    return true;
  }
  /* まとめて塗る。balls は ball（上）に加えて dims を持ってもよい。
     opts = { tMs, dims, facets, surfaces, rays, every, topDown }。返り値＝描いた球の数。 */
  function paintMirrorBalls(ctx, balls, P, opts) {
    if (!Array.isArray(balls) || !balls.length || typeof Path2D === "undefined") return 0;
    const o = opts || {};
    let drawn = 0;
    balls.forEach((ball) => {
      if (!ball || !ball.centre) return;
      const res = mirrorBallDotsAt(ball, o.tMs, { dims: o.dims || ball.dims, facets: o.facets, surfaces: o.surfaces, every: o.every });
      const groups = new Map(), halos = new Map(), rays = new Map();
      res.dots.forEach((dot) => {
        const q = P(dot.P); if (!q) return;
        const axes = MIRROR_BALL_AXES[dot.on]; if (!axes) return;
        const qa = P({ x: dot.P.x + axes[0].x * dot.rm, y: dot.P.y + axes[0].y * dot.rm, z: dot.P.z + axes[0].z * dot.rm });
        const qb = P({ x: dot.P.x + axes[1].x * dot.rm, y: dot.P.y + axes[1].y * dot.rm, z: dot.P.z + axes[1].z * dot.rm });
        if (!qa || !qb) return;
        const ax = qa.X - q.X, ay = qa.Y - q.Y, bx = qb.X - q.X, by = qb.Y - q.Y;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (!Number.isFinite(la + lb)) return;
        /* 2軸が画面上で直交していなくても楕円で近似する（長い方を長軸、もう片方の直交成分を短軸）。 */
        const longer = la >= lb ? { x: ax, y: ay, len: la } : { x: bx, y: by, len: lb };
        const other = la >= lb ? { x: bx, y: by } : { x: ax, y: ay };
        const across = longer.len > 0 ? Math.abs(longer.x * other.y - longer.y * other.x) / longer.len : 0;
        const rx = Math.max(0.6, longer.len), ry = Math.max(0.4, across);
        if (rx > 400) return;                      // カメラの至近で画面いっぱいになる粒は描かない
        const rot = longer.len > 0 ? Math.atan2(longer.y, longer.x) : 0;
        const key = `${dot.color}|${dot.bin}`;
        let path = groups.get(key); if (!path) { path = new Path2D(); groups.set(key, path); }
        path.moveTo(q.X + rx * Math.cos(rot), q.Y + rx * Math.sin(rot));
        path.ellipse(q.X, q.Y, rx, ry, rot, 0, Math.PI * 2);
        let halo = halos.get(key); if (!halo) { halo = new Path2D(); halos.set(key, halo); }
        halo.moveTo(q.X + rx * MIRROR_BALL_HALO * Math.cos(rot), q.Y + rx * MIRROR_BALL_HALO * Math.sin(rot));
        halo.ellipse(q.X, q.Y, rx * MIRROR_BALL_HALO, ry * MIRROR_BALL_HALO, rot, 0, Math.PI * 2);
        if (o.rays && dot.ray) {
          const f = P(dot.F);
          if (f) { let line = rays.get(dot.color); if (!line) { line = new Path2D(); rays.set(dot.color, line); } line.moveTo(f.X, f.Y); line.lineTo(q.X, q.Y); }
        }
      });
      if (groups.size) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        halos.forEach((path, key) => { const at = key.lastIndexOf("|"); ctx.fillStyle = rgba(key.slice(0, at), MIRROR_BALL_DOT_ALPHA[+key.slice(at + 1)] * 0.18); ctx.fill(path); });
        groups.forEach((path, key) => { const at = key.lastIndexOf("|"); ctx.fillStyle = rgba(key.slice(0, at), MIRROR_BALL_DOT_ALPHA[+key.slice(at + 1)]); ctx.fill(path); });
        rays.forEach((path, colour) => { ctx.strokeStyle = rgba(colour, MIRROR_BALL_RAY_ALPHA); ctx.lineWidth = 1; ctx.stroke(path); });
        ctx.restore();
      }
      paintMirrorBallBody(ctx, ball, P, o);
      drawn += 1;
    });
    return drawn;
  }

  const api = Object.freeze({
    paintPool, paintPools, paintBeam, paintBeams, paintWorkLight, litLevelAt, paintLaser, paintLasers,
    mirrorBallFacets, mirrorBallDotsAt, mirrorBallGlintsAt, paintMirrorBalls, paintMirrorBallBody, MIRROR_BALL_FACETS, MIRROR_BALL_HANG_M,
    beamFalloff, beamLandingTangents, fadeBeamLanding, beamSheetFor, beamSheetGeometry, rootGlowBounds, clearBeamCache, beamCacheStats, litColorAt, tintColor, hazeAmount, hazeAt, noise3,
    TOKENS: Object.freeze({ BEAM_CACHE_MAX_PX, SMOOTH_POOL_TEMP_PX, ROOT_FRAC, VISUAL_GAIN, BEAM_SOFT, ALPHA_CORE, ALPHA_MID, ALPHA_EDGE, SOFT_DEFAULT,
      MIN_AREA_PX, BAND_ALPHA, BAND_MIN_PX, LINE_ALPHA, LINE_MIN_PX, HOLE_BAND, HOLE_LINE_PX,
      BEAM_FALL_R0, BEAM_FALL_P, BEAM_FALL_LO, BEAM_FALL_HI, BEAM_FALL_STOPS, BEAM_FALL_NORM_T, BEAM_LANDING_FADE_START,
      HAZE_AMOUNT, HAZE_MAX, HAZE_SCALE_M, COSTUME_AMBIENT,
      MIRROR_BALL_FACETS, MIRROR_BALL_DOT_BASE_M, MIRROR_BALL_DOT_SPREAD, MIRROR_BALL_DOT_FALL_M, MIRROR_BALL_DOT_ALPHA,
      MIRROR_BALL_RAY_EVERY, MIRROR_BALL_RAY_ALPHA, MIRROR_BALL_HALO, MIRROR_BALL_HANG_M,
      MIRROR_BALL_GLINT_SIGMA_DEG, MIRROR_BALL_GLINT_FACETS, MIRROR_BALL_GLINT_MAX }),
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SHOSAI_LIGHT_RENDER = api;
})(typeof window !== "undefined" ? window : globalThis);
