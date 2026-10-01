// 複製元: show-creative-ideas/stage-sketch-gamma/stage-light-render.js（2026-10-01 時点）。音アタリ側では編集しない。直すときは元を直してから再複製
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
  const BEAM_SOFT = 1.26;       // 縁の半影のぶん、楕円を少し広げる
  const ALPHA_CORE = 0.50;      // 中心の濃さ（2026-09-19 本人決定「全体+50%」で 0.34→0.50）
  const ALPHA_MID = 0.27;       // 芯の外（同上 0.18→0.27）
  const ALPHA_EDGE = 0.075;     // 縁の手前（同上 0.05→0.075）
  const SOFT_DEFAULT = 2;       // 縁の柔らかさの既定（0〜10）
  const MIN_AREA_PX = 4;        // これ未満は潰れている＝その図では線にしか見えない
  const MAX_TEMP_PX = 1024;     // 濃淡用の一時キャンバスの上限
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

    const alpha = clamp(level * VISUAL_GAIN, 0, 1);
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
    const size = Math.min(MAX_TEMP_PX, Math.max(8, Math.ceil(radius * 2)));
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
  function beamGradient(target, from, cornerP, cornerM, colour, alpha, softness, gain) {
    const soft = clamp(finite(softness, SOFT_DEFAULT), 0, 10);
    const feather = 0.06 + soft * 0.035;
    const profile = [[0, 0], [feather * 0.45, 0.3], [feather, 1],
      [1 - feather, 1], [1 - feather * 0.45, 0.3], [1, 0]];
    const lift = Math.max(0, finite(gain, 1));
    /* 筋は灯体（点）から放射状に伸びる。扇形のグラデーションなら等値線が灯体から出る半直線になる。
       扇形が無い環境では平行のグラデーションへ戻す（見え方は近い）。 */
    if (typeof target.createConicGradient === "function") {
      const TAU = Math.PI * 2;
      const wrap = (value) => ((value % TAU) + TAU) % TAU;
      const angleAt = (t) => Math.atan2(
        cornerM.Y + (cornerP.Y - cornerM.Y) * t - from.Y,
        cornerM.X + (cornerP.X - cornerM.X) * t - from.X);
      const left = angleAt(0), right = angleAt(1);
      const clockwise = wrap(right - left) <= Math.PI;
      const start = clockwise ? left : right;
      const sweep = clockwise ? wrap(right - left) : wrap(left - right);
      if (sweep > 1e-4) {
        const gradient = target.createConicGradient(start, from.X, from.Y);
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

  function paintBeam(ctx, pool, P, opts) {
    if (!pool || !pool.c || !pool.eb || !pool.from) return false;
    const level = clamp(finite(pool.level, 0), 0, 100) / 100;
    if (!(level > 0)) return false;
    const from = P(pool.from);
    const centre = P(pool.c);
    if (!from || !centre) return false;
    const span = Math.hypot(centre.X - from.X, centre.Y - from.Y);
    const alpha = clamp(level * VISUAL_GAIN, 0, 1);

    if (opts && opts.topDown) {
      if (!(span > LINE_MIN_PX)) return false;
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
    const alongB = P(add(pool.c, pool.eb));
    if (!alongB) return false;
    const bx = (alongB.X - centre.X) * BEAM_SOFT, by = (alongB.Y - centre.Y) * BEAM_SOFT;
    if (!Number.isFinite(bx + by) || Math.hypot(bx, by) < 1) return false;

    const cornerP = { X: centre.X + bx, Y: centre.Y + by };
    const cornerM = { X: centre.X - bx, Y: centre.Y - by };

    /* 長さ方向の濃淡（灯体に近いほど明るい）。
       ★掛け算なので、光だまりと同じく**別のキャンバスで「横断 × 長さ」を作ってから1枚で載せる**。
         destination-in はαを減らすことしかできないので、三角形の側を BEAM_FALL_HI 倍だけ濃く塗り、
         色止めを HI で割って 0〜1 に収める。掛け合わせると元の濃さ × 倍率に戻る。 */
    const stops = beamFalloff(pool, P, BEAM_FALL_STOPS, opts && opts.haze);   // opts.haze＝むらの振れ幅（hazeAmount で写した値）
    const sheet = stops ? beamSheetFor(ctx, from, cornerP, cornerM) : null;

    if (!sheet) {
      /* ブラウザが無い／画面の外／一時キャンバスを作れないときは、長さ方向を掛けずにそのまま塗る
         （2026-09-18 までの見え方と同じ）。黙って落ちるより、薄くても筋が出るほうがよい。 */
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.fillStyle = beamGradient(ctx, from, cornerP, cornerM, pool.color, alpha, pool.softness, 1);
      ctx.beginPath();
      ctx.moveTo(from.X, from.Y);      // 灯体は点。点から広がる三角なら捻れない
      ctx.lineTo(cornerP.X, cornerP.Y);
      ctx.lineTo(cornerM.X, cornerM.Y);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      return true;
    }

    const { canvas, ctx: sheetCtx, x0, y0, w, h, pw, ph, sx, sy } = sheet;
    sheetCtx.setTransform(1, 0, 0, 1, 0, 0);
    sheetCtx.clearRect(0, 0, pw, ph);
    sheetCtx.setTransform(sx, 0, 0, sy, -x0 * sx, -y0 * sy);   // 以降は本体と同じ座標系のまま書ける
    sheetCtx.fillStyle = beamGradient(
      sheetCtx, from, cornerP, cornerM, pool.color, alpha, pool.softness, BEAM_FALL_HI);
    sheetCtx.beginPath();
    sheetCtx.moveTo(from.X, from.Y);
    sheetCtx.lineTo(cornerP.X, cornerP.Y);
    sheetCtx.lineTo(cornerM.X, cornerM.Y);
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
    sheetCtx.setTransform(1, 0, 0, 1, 0, 0);

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    ctx.drawImage(canvas, 0, 0, pw, ph, x0, y0, w, h);
    ctx.restore();
    return true;
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

  function beamSheetFor(ctx, from, cornerP, cornerM) {
    const target = ctx && ctx.canvas;
    const cw = target ? finite(target.width, 0) : 0;
    const ch = target ? finite(target.height, 0) : 0;
    if (!(cw > 0 && ch > 0)) return null;
    const xs = [from.X, cornerP.X, cornerM.X], ys = [from.Y, cornerP.Y, cornerM.Y];
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
    const canvas = beamCanvas(pw, ph);
    if (!canvas) return null;
    const sheetCtx = canvas.getContext ? canvas.getContext("2d") : null;
    if (!sheetCtx) return null;
    return { canvas, ctx: sheetCtx, x0, y0, w, h, pw, ph, sx, sy };
  }

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

  const api = Object.freeze({
    paintPool, paintPools, paintBeam, paintBeams, paintWorkLight, litLevelAt, paintLaser, paintLasers,
    beamFalloff, beamSheetFor, litColorAt, tintColor, hazeAmount, hazeAt, noise3,
    TOKENS: Object.freeze({ VISUAL_GAIN, BEAM_SOFT, ALPHA_CORE, ALPHA_MID, ALPHA_EDGE, SOFT_DEFAULT,
      MIN_AREA_PX, BAND_ALPHA, BAND_MIN_PX, LINE_ALPHA, LINE_MIN_PX, HOLE_BAND, HOLE_LINE_PX,
      BEAM_FALL_R0, BEAM_FALL_P, BEAM_FALL_LO, BEAM_FALL_HI, BEAM_FALL_STOPS, BEAM_FALL_NORM_T,
      HAZE_AMOUNT, HAZE_MAX, HAZE_SCALE_M, COSTUME_AMBIENT }),
  });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SHOSAI_LIGHT_RENDER = api;
})(typeof window !== "undefined" ? window : globalThis);
