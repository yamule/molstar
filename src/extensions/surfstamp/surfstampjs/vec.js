// Small vector helpers. Vectors are plain arrays [x,y,z] / [x,y] for speed and simplicity.

export const v3 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]),
  dist2: (a, b) => { const x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2]; return x * x + y * y + z * z; },
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
  mean: (arr) => {
    const o = [0, 0, 0];
    for (const a of arr) { o[0] += a[0]; o[1] += a[1]; o[2] += a[2]; }
    const n = arr.length || 1;
    return [o[0] / n, o[1] / n, o[2] / n];
  },
  /** Unit normal of triangle (a,b,c) with right-hand rule: (b-a) x (c-a). */
  triNormal: (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    return l > 0 ? [nx / l, ny / l, nz / l] : [0, 0, 0];
  },
  triArea: (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  },
  /** angle between two vectors in radians (0..pi) */
  angle: (a, b) => {
    const d = v3.dot(a, b) / (v3.len(a) * v3.len(b) || 1);
    return Math.acos(Math.max(-1, Math.min(1, d)));
  },
};

export const v2 = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1]],
  scale: (a, s) => [a[0] * s, a[1] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1],
  cross: (a, b) => a[0] * b[1] - a[1] * b[0],
  len: (a) => Math.hypot(a[0], a[1]),
  dist: (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]),
  norm: (a) => { const l = Math.hypot(a[0], a[1]); return l > 0 ? [a[0] / l, a[1] / l] : [0, 0]; },
  mean: (arr) => {
    let x = 0, y = 0;
    for (const a of arr) { x += a[0]; y += a[1]; }
    const n = arr.length || 1;
    return [x / n, y / n];
  },
  /** signed area *2 of triangle: >0 counter-clockwise (in y-up coords) */
  orient: (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  triArea: (a, b, c) => Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2,
};

/** Segment intersection test (proper or touching). */
export function segmentsIntersect(a, b, c, d) {
  const o1 = v2.orient(a, b, c), o2 = v2.orient(a, b, d), o3 = v2.orient(c, d, a), o4 = v2.orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  const onSeg = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
  if (o1 === 0 && onSeg(a, b, c)) return true;
  if (o2 === 0 && onSeg(a, b, d)) return true;
  if (o3 === 0 && onSeg(c, d, a)) return true;
  if (o4 === 0 && onSeg(c, d, b)) return true;
  return false;
}

/** Point in triangle (inclusive). */
export function pointInTriangle(p, a, b, c) {
  const d1 = v2.orient(a, b, p), d2 = v2.orient(b, c, p), d3 = v2.orient(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/** Do two 2D triangles overlap with positive area (shared edges/vertices don't count)? */
export function trianglesOverlap(t1, t2, eps = 1e-9) {
  // Separating axis theorem on 6 edge normals.
  const tris = [t1, t2];
  for (let t = 0; t < 2; t++) {
    const tri = tris[t];
    for (let i = 0; i < 3; i++) {
      const a = tri[i], b = tri[(i + 1) % 3];
      const nx = -(b[1] - a[1]), ny = b[0] - a[0];
      let min1 = Infinity, max1 = -Infinity, min2 = Infinity, max2 = -Infinity;
      for (const p of t1) { const v = p[0] * nx + p[1] * ny; if (v < min1) min1 = v; if (v > max1) max1 = v; }
      for (const p of t2) { const v = p[0] * nx + p[1] * ny; if (v < min2) min2 = v; if (v > max2) max2 = v; }
      const scale = Math.hypot(nx, ny) || 1;
      if (max1 - min2 <= eps * scale || max2 - min1 <= eps * scale) return false;
    }
  }
  return true;
}
