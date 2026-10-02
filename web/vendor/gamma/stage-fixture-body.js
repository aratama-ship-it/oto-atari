/* fixture-body.js — ムービングライトの簡易3D形状（2026-09-27 B案）
   土台（円柱）・ヨーク（コの字の2枚の板）・ヘッド（円柱）の3部品を世界座標(m)で組み、
   狙い先からパン（鉛直軸まわり）とチルト（ヨークの横軸まわり）を計算してヘッドを向ける。
   投影は呼び出し側が渡す P(world)→{X,Y}。平面図・正面図・γの3D、どれでも同じ幾何を使う。
   ★型番は持たない汎用の形。寸法は一般的な中型ムービング（幅約0.35m・高さ約0.55m）の目安。
   世界座標: x=左右（中央0・上手が+）、y=奥行き（奥0・客席が+）、z=高さ（床0）。 */
(function (root) {
  "use strict";
  const SIZE = { baseR: 0.11, baseH: 0.10, armSpread: 0.17, armDrop: 0.32, armDepth: 0.06, headR: 0.10, headL: 0.34 };
  const norm = (v) => { const l = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / l, y: v.y / l, z: v.z / l }; };
  const add = (a, b, k = 1) => ({ x: a.x + b.x * k, y: a.y + b.y * k, z: a.z + b.z * k });
  const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
  const ring = (c, u, v, r, n) => Array.from({ length: n }, (_, i) => { const t = (i / n) * Math.PI * 2; return add(add(c, u, Math.cos(t) * r), v, Math.sin(t) * r); });

  /* S: 吊り点（トラスに付く点）。aim: 狙い先（null なら真下）。opts.scale で全体を拡大（小さな図で見やすくする）。 */
  function movingHead(S, aim, opts = {}) {
    const k = Number(opts.scale) > 0 ? Number(opts.scale) : 1;
    const sz = Object.fromEntries(Object.entries(SIZE).map(([key, v]) => [key, v * k]));
    const pivot = { x: S.x, y: S.y, z: S.z - sz.baseH - sz.armDrop };
    let d = aim ? norm({ x: aim.x - pivot.x, y: aim.y - pivot.y, z: aim.z - pivot.z }) : { x: 0, y: 0, z: -1 };
    if (!Number.isFinite(d.x + d.y + d.z)) d = { x: 0, y: 0, z: -1 };
    const tilt = Math.acos(Math.max(-1, Math.min(1, -d.z)));               // 0=真下 … π=真上
    const pan = Math.hypot(d.x, d.y) < 1e-6 ? 0 : Math.atan2(d.x, d.y);   // 0=客席向き
    const f = { x: Math.sin(pan), y: Math.cos(pan), z: 0 };                 // ヨークの正面
    const r = { x: Math.cos(pan), y: -Math.sin(pan), z: 0 };                // ヨークの横（チルト軸）
    const up = { x: 0, y: 0, z: 1 };
    const e = norm(cross(d, r));                                             // ヘッド断面のもう1軸
    const baseTop = { x: S.x, y: S.y, z: S.z }, baseBot = { x: S.x, y: S.y, z: S.z - sz.baseH };
    const arm = (side) => {
      const o = add(baseBot, r, side * sz.armSpread);
      const lo = { x: o.x, y: o.y, z: pivot.z - sz.headR * 0.4 };
      return [add(o, f, -sz.armDepth), add(o, f, sz.armDepth), add(lo, f, sz.armDepth), add(lo, f, -sz.armDepth)];
    };
    const backC = add(pivot, d, -sz.headL / 2), frontC = add(pivot, d, sz.headL / 2);
    return {
      pan, tilt, dir: d, pivot, lens: frontC, scale: k, size: sz,
      base: { top: ring(baseTop, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, sz.baseR, 14), bottom: ring(baseBot, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, sz.baseR, 14) },
      yoke: { bar: [add(baseBot, r, -sz.armSpread), add(baseBot, r, sz.armSpread)], arms: [arm(-1), arm(1)] },
      head: { back: ring(backC, r, e, sz.headR, 16), front: ring(frontC, r, e, sz.headR, 16), rails: [[add(backC, r, sz.headR), add(frontC, r, sz.headR)], [add(backC, r, -sz.headR), add(frontC, r, -sz.headR)], [add(backC, e, sz.headR), add(frontC, e, sz.headR)], [add(backC, e, -sz.headR), add(frontC, e, -sz.headR)]] },
      bbox: [baseTop, pivot, backC, frontC],
    };
  }

  /* 固定灯（PAR・スポット）。トラスからフックで吊った短い円筒。向きは狙い先で決まるが、実機は仕込みで固定。
     ムービングと同じ形式で返すので draw() と lens（点光源）をそのまま使える。 */
  function parCan(S, aim, opts = {}) {
    const k = Number(opts.scale) > 0 ? Number(opts.scale) : 1;
    const hookH = 0.12 * k, canR = 0.09 * k, canL = 0.26 * k;
    const pivot = { x: S.x, y: S.y, z: S.z - hookH - canR * 0.6 };
    let d = aim ? norm({ x: aim.x - pivot.x, y: aim.y - pivot.y, z: aim.z - pivot.z }) : { x: 0, y: 0, z: -1 };
    if (!Number.isFinite(d.x + d.y + d.z)) d = { x: 0, y: 0, z: -1 };
    const tilt = Math.acos(Math.max(-1, Math.min(1, -d.z)));
    const pan = Math.hypot(d.x, d.y) < 1e-6 ? 0 : Math.atan2(d.x, d.y);
    const r = { x: Math.cos(pan), y: -Math.sin(pan), z: 0 };
    const e = norm(cross(d, r));
    const backC = add(pivot, d, -canL * 0.35), frontC = add(pivot, d, canL * 0.65);
    const hookTop = { x: S.x, y: S.y, z: S.z }, hookBot = { x: S.x, y: S.y, z: S.z - hookH };
    return {
      pan, tilt, dir: d, pivot, lens: frontC, scale: k, kind: "par",
      size: { headR: canR, headL: canL },
      base: { top: ring(hookTop, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.04 * k, 8), bottom: ring(hookBot, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, 0.04 * k, 8) },
      yoke: { bar: [hookBot, pivot], arms: [] },
      head: { back: ring(backC, r, e, canR, 12), front: ring(frontC, r, e, canR, 12), rails: [[add(backC, r, canR), add(frontC, r, canR)], [add(backC, r, -canR), add(frontC, r, -canR)], [add(backC, e, canR), add(frontC, e, canR)], [add(backC, e, -canR), add(frontC, e, -canR)]] },
      bbox: [hookTop, pivot, backC, frontC],
    };
  }

  /* 点光源のグレア（レンズ面の明るい芯）。細い光ほど芯が締まり、強いほど大きい。
     半径は画面px。opts.px は「1m が何px か」（無ければ 40）。 */
  function lensGlow(ctx, P, geom, opts = {}) {
    const lit = Math.max(0, Math.min(1, Number(opts.lit) || 0));
    if (lit <= 0.02 || !opts.color) return;
    const q = P(geom.lens); if (!q || !Number.isFinite(q.X + q.Y)) return;
    const px = Number(opts.px) > 0 ? Number(opts.px) : 40;
    const beamDeg = Math.max(4, Math.min(70, Number(opts.beamDeg) || 18));
    const core = Math.max(2.5, geom.size.headR * px * (0.55 + 0.45 * lit));
    const halo = core * (2.2 + (40 - beamDeg) / 40 * 1.2) * (0.6 + 0.4 * lit);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const g = ctx.createRadialGradient(q.X, q.Y, 0, q.X, q.Y, halo);
    g.addColorStop(0, hexA("#ffffff", 0.85 * lit)); g.addColorStop(0.18, hexA(opts.color, 0.75 * lit)); g.addColorStop(0.5, hexA(opts.color, 0.18 * lit)); g.addColorStop(1, hexA(opts.color, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(q.X, q.Y, halo, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /* 画面上の点の凸包（円柱の影絵＝2つの輪の凸包）。胴体を面として塗り、光の根元を隠せるようにする。 */
  function hull(points) {
    const pts = points.filter((q) => q && Number.isFinite(q.X + q.Y)).sort((a, b) => a.X - b.X || a.Y - b.Y);
    if (pts.length < 3) return pts;
    const cross = (o, a, b) => (a.X - o.X) * (b.Y - o.Y) - (a.Y - o.Y) * (b.X - o.X);
    const lower = []; for (const q of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
    const upper = []; for (let i = pts.length - 1; i >= 0; i--) { const q = pts[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
    upper.pop(); lower.pop(); return lower.concat(upper);
  }

  /* 描く。P(world)→{X,Y}。opts: color（点灯色）, lit（0〜1）, selected, ink（線色）, fill（面色）, beamDeg, px,
     topDown（真上から見る図＝レンズの光と芯は胴体の下に隠れるので出さない。胴体の上面を塗って光の根元を隠す） */
  function draw(ctx, P, geom, opts = {}) {
    const appearance = ["black", "gray"].includes(opts.appearance) ? opts.appearance : "white-line";
    const appearanceColors = appearance === "black"
      ? { ink: "#55514d", fill: "#090909" }
      : appearance === "gray" ? { ink: "#aaa6a0", fill: "#68645f" }
        : { ink: "rgba(239,231,214,0.75)", fill: "#2b2621" };
    const ink = opts.ink || appearanceColors.ink, fill = opts.fill || appearanceColors.fill, sel = opts.selected, topDown = Boolean(opts.topDown);
    const lw = opts.lineWidth || (sel ? 2 : 1.1);
    const poly = (pts, fillStyle, strokeStyle, close = true) => {
      ctx.beginPath(); pts.forEach((p, i) => { const q = P(p); if (i) ctx.lineTo(q.X, q.Y); else ctx.moveTo(q.X, q.Y); });
      if (close) ctx.closePath();
      if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
      if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lw; ctx.stroke(); }
    };
    const polyScreen = (qs, fillStyle, strokeStyle) => {
      if (qs.length < 3) return;
      ctx.beginPath(); qs.forEach((q, i) => (i ? ctx.lineTo(q.X, q.Y) : ctx.moveTo(q.X, q.Y))); ctx.closePath();
      if (fillStyle) { ctx.fillStyle = fillStyle; ctx.fill(); }
      if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lw; ctx.stroke(); }
    };
    const lit = Math.max(0, Math.min(1, Number(opts.lit) || 0));
    ctx.save();
    ctx.lineJoin = "round";
    // 土台（円柱の影絵）
    polyScreen(hull(geom.base.top.concat(geom.base.bottom).map(P)), fill, ink);
    poly(geom.base.top, appearance === "white-line" ? "#3a3128" : fill, ink);
    (geom.yoke.arms || []).forEach((arm) => poly(arm, fill, ink));
    poly(geom.yoke.bar, null, ink, false);
    // ヘッド: 円柱の影絵を面で塗る（上から見ると胴体が光の根元を隠す）→ 後ろの輪 → レール → レンズ
    polyScreen(hull(geom.head.back.concat(geom.head.front).map(P)), fill, ink);
    poly(geom.head.back, fill, ink);
    geom.head.rails.forEach((rail) => poly(rail, null, ink, false));
    if (topDown) {
      /* 上から: レンズは胴体の下。縁だけ、点いていれば色が少し漏れて見える。 */
      poly(geom.head.front, appearance === "white-line" ? "#1a1613" : fill, lit > 0 && opts.color ? hexA(opts.color, 0.35 + 0.45 * lit) : (sel ? "#df6433" : ink));
      ctx.restore();
      return;
    }
    /* レンズ面＝点光源。点いていれば色で塗り、中心に白い芯。消えていれば暗いガラス。 */
    const lens = lit > 0 && opts.color ? hexA(opts.color, 0.35 + 0.65 * lit) : appearance === "white-line" ? "#1a1613" : fill;
    poly(geom.head.front, lens, sel ? "#df6433" : ink);
    ctx.restore();
    if (opts.glow !== false) lensGlow(ctx, P, geom, opts);
  }
  const hexA = (hex, a) => { const n = parseInt(String(hex || "#ffffff").slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`; };
  const deg = (rad) => Math.round(rad * 180 / Math.PI);

  root.FIXTURE_BODY = Object.freeze({ SIZE, movingHead, parCan, draw, lensGlow, hull, deg });
})(typeof window !== "undefined" ? window : globalThis);
