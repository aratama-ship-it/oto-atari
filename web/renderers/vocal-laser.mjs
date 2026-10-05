// 舞台の空気に描く口。γ座標 {x:左右,y:奥→手前,z:高さ}。正本: TOKEN_SHEET §23。
// 口形と音源時刻だけから描く。前フレームや壁時計を使わず、シークで煙も再現する。
export const VOCAL_LASER_STYLE = Object.freeze({
  center: Object.freeze({ x: 0, y: 4.8, z: 3.3 }), scale: 2.08,
  source: Object.freeze({ x: -5, y: 1, z: 0.35 }),
  color: '#3ce0f6', core: '#c6f8ff', segments: 64, rayCount: 44,
  lineM: 0.015, smokeCount: 28, textureSize: 128,
});
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const unit = (n) => Number.isFinite(n) ? clamp(n, 0, 1) : 0;
const smooth = (n) => { const u = unit(n); return u * u * (3 - 2 * u); };
const mix = (a, b, t) => a + (b - a) * t;
const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${unit(a)})`;
};

export function buildVocalGeometry(shape = {}) {
  const s = VOCAL_LASER_STYLE, c = s.center;
  const open = unit(shape.open), stretch = unit(shape.stretch), round = unit(shape.round);
  const width = 1 + .19 * stretch - .31 * round, height = .008 + .49 * open;
  const world = (x, y, z) => ({ x: c.x + x * s.scale, y: c.y + z * s.scale, z: c.z + y * s.scale });
  const lip = (upper, u, phi) => {
    const sign = upper ? 1 : -1, arc = Math.pow(Math.max(0, 1 - u * u), .62);
    const cupid = upper ? 1 - .18 * Math.exp(-((u / .16) ** 2)) + .14 * Math.exp(-(((Math.abs(u) - .24) / .18) ** 2)) : 1;
    const thick = ((upper ? .27 : .31) + .035 * round) * arc * cupid;
    const edge = sign * height * arc + (upper ? .018 * (1 - Math.exp(-((u / .17) ** 2))) * arc : 0);
    return world(u * width, edge + sign * thick * (1 + Math.cos(phi)) / 2,
      .06 + round * .22 * arc + (.18 + .04 * round) * arc * Math.sin(phi) - .06 * u * u);
  };
  const curves = [], rays = [];
  for (const upper of [true, false]) {
    for (const [phi, alpha, core] of [[0, 1, true], [Math.PI, .85, true],
      [.28 * Math.PI, .25, false], [.50 * Math.PI, .34, false], [.72 * Math.PI, .22, false],
      [1.3 * Math.PI, .07, false], [1.7 * Math.PI, .07, false]]) {
      curves.push({ alpha, core, points: Array.from({ length: s.segments + 1 }, (_, i) => lip(upper, i / s.segments * 2 - 1, phi)) });
    }
    for (let k = 1; k < 12; k++) curves.push({ alpha: .10, core: false,
      points: Array.from({ length: 21 }, (_, i) => lip(upper, k / 6 - 1, i / 20 * Math.PI)) });
    for (let k = 0; k < s.rayCount / 2; k++) rays.push(lip(upper, -.98 + k / (s.rayCount / 2 - 1) * 1.96, 0));
  }
  // 内部は淡い曲線。開口から連続的に現れ、閉じる時に突然消える面を作らない。
  const reveal = smooth(open / .16);
  curves.push({ alpha: .20 * reveal, core: false,
    points: Array.from({ length: 41 }, (_, i) => {
      const u = (i / 40 * 2 - 1) * .65, arc = Math.sqrt(1 - u * u);
      return world(u * width, height * arc - Math.min(.10, height * .45), -.02 + round * .12);
    }) });
  curves.push({ alpha: .12 * reveal, core: false,
    points: Array.from({ length: 41 }, (_, i) => {
      const a = i / 40 * Math.PI;
      return world(.45 * width * Math.cos(a), -height * .7 + Math.sin(a) * height * .35, -.025 + Math.sin(a) * .08);
    }) });
  return { curves, rays, source: s.source, center: c, intensity: .68 + .22 * unit(shape.energy) };
}

// 固定配置へ低周波の揺らぎだけを足す。ループ端や再生開始に粒子を再生成しない。
export function vocalHazeAt(time) {
  const t = Number.isFinite(time) ? time : 0, s = VOCAL_LASER_STYLE;
  const size = s.scale / 2.6;
  return Array.from({ length: s.smokeCount }, (_, i) => {
    const a = i * 2.399963229728653, phase = i * 1.713;
    const onPath = i >= 18, f = (i - 17) / 11;
    const center = onPath ? {
      x: mix(s.source.x, s.center.x, f) + .36 * Math.sin(a) * f,
      y: mix(s.source.y, s.center.y, f), z: mix(s.source.z, s.center.z, f),
    } : {
      x: s.center.x + Math.cos(a) * (1 + (i % 3) * .58) * size,
      y: s.center.y + Math.sin(a) * .65 * size,
      z: s.center.z + Math.sin(a) * (i % 2 ? .9 : 1.25) * size,
    };
    return { ...center, x: center.x + .22 * size * Math.sin(t * .17 + phase),
      z: center.z + .12 * size * Math.sin(t * .13 + phase),
      radius: (.6 + (i % 4) * .2) * size, alpha: onPath ? .10 : .14 + .03 * Math.sin(t * .11 + phase),
      rotation: a + .025 * t, stretch: 1.3 + (i % 3) * .22 };
  });
}

let smokeTexture;
function getSmokeTexture() {
  if (smokeTexture) return smokeTexture;
  const size = VOCAL_LASER_STYLE.textureSize, canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(size, size);
  const hash = (x, y) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + 1274126177;
    n = Math.imul(n ^ n >>> 13, 1274126177); return ((n ^ n >>> 16) >>> 0) / 4294967295;
  };
  const noise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), ux = smooth(x - ix), uy = smooth(y - iy);
    return mix(mix(hash(ix, iy), hash(ix + 1, iy), ux), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux), uy);
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size * 2 - 1, v = (y + .5) / size * 2 - 1, r = Math.hypot(u, v);
    const n = .55 * noise(x / 20, y / 26) + .28 * noise(x / 8 + 21, y / 11) + .17 * noise(x / 3 + 40, y / 4);
    const alpha = Math.pow(Math.max(0, 1 - r * r), 2) * Math.pow(n, 1.4);
    const at = (y * size + x) * 4;
    pixels.data.set([86, 190, 202, Math.round(alpha * 255)], at);
  }
  ctx.putImageData(pixels, 0, 0); smokeTexture = canvas;
  return canvas;
}

function path(ctx, points, P) {
  ctx.beginPath(); let started = false, visible = false;
  for (const point of points) {
    const p = P(point);
    if (!p) { started = false; continue; }
    if (started) { ctx.lineTo(p.X, p.Y); visible = true; }
    else ctx.moveTo(p.X, p.Y);
    started = true;
  }
  return visible;
}

/** 接続先の投影を渡す。舞台と口が同じカメラ・レンズ・resizeを使う。 */
export function drawVocalLaser(ctx, shape, time, P) {
  if (!shape) return;
  const s = VOCAL_LASER_STYLE, model = buildVocalGeometry(shape), c = P(s.center);
  if (!c) return;
  const scalePoint = P({ ...s.center, z: s.center.z + 1 });
  if (!scalePoint) return;
  const px = Math.hypot(scalePoint.X - c.X, scalePoint.Y - c.Y);
  const width = clamp(px * s.lineM, .65, 1.5), intensity = model.intensity;
  ctx.save(); ctx.globalCompositeOperation = 'screen'; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const source = P(model.source), endPoints = model.rays.map(P);
  if (source) {
    // 広がる光の扇を薄く残し、煙の粒と光路がつながるようにする。
    for (let i = 1; i < endPoints.length; i++) {
      const a = endPoints[i - 1], b = endPoints[i];
      if (!a || !b || i === s.rayCount / 2) continue;
      ctx.beginPath(); ctx.moveTo(source.X, source.Y); ctx.lineTo(a.X, a.Y); ctx.lineTo(b.X, b.Y); ctx.closePath();
      ctx.fillStyle = rgba(s.color, .012 * intensity); ctx.fill();
    }
    for (let i = 0; i < endPoints.length; i++) {
      const p = endPoints[i]; if (!p) continue;
      const gradient = ctx.createLinearGradient(source.X, source.Y, p.X, p.Y);
      gradient.addColorStop(0, rgba(s.color, .05 * intensity));
      gradient.addColorStop(.55, rgba(s.color, (.075 + .035 * Math.sin(i * 1.4) ** 2) * intensity));
      gradient.addColorStop(1, rgba(s.color, .05 * intensity));
      ctx.strokeStyle = gradient; ctx.lineWidth = width;
      ctx.beginPath(); ctx.moveTo(source.X, source.Y); ctx.lineTo(p.X, p.Y); ctx.stroke();
    }
  }
  const texture = getSmokeTexture();
  for (const cloud of vocalHazeAt(time)) {
    const at = P(cloud), edge = P({ ...cloud, z: cloud.z + cloud.radius });
    if (!at || !edge) continue;
    const r = Math.hypot(edge.X - at.X, edge.Y - at.Y);
    if (!(r > 0 && r < ctx.canvas.width * 2)) continue;
    ctx.save(); ctx.translate(at.X, at.Y); ctx.rotate(cloud.rotation);
    ctx.globalAlpha = cloud.alpha * intensity;
    ctx.drawImage(texture, -r * cloud.stretch, -r, r * 2 * cloud.stretch, r * 2); ctx.restore();
  }
  // にじみ→光の線→細い芯。影や不透明のポリゴンで口を埋めない。
  for (const [widthScale, alpha, color] of [[4.5, .07, s.color], [2.2, .18, s.color], [1, .78, s.core]]) {
    for (const curve of model.curves) {
      if (!path(ctx, curve.points, P)) continue;
      ctx.lineWidth = width * widthScale;
      ctx.strokeStyle = rgba(curve.core ? color : s.color, alpha * curve.alpha * intensity);
      ctx.stroke();
    }
  }
  ctx.restore();
}
