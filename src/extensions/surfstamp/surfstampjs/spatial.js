// Uniform-grid spatial hash for 3D points (radius queries and nearest neighbour).

export class PointGrid {
  /**
   * @param {Array<[number,number,number]>} points
   * @param {number} cellSize
   */
  constructor(points, cellSize) {
    this.points = points;
    this.cell = cellSize;
    this.min = [Infinity, Infinity, Infinity];
    for (const p of points) for (let k = 0; k < 3; k++) if (p[k] < this.min[k]) this.min[k] = p[k];
    if (!points.length) this.min = [0, 0, 0];
    this.map = new Map();
    for (let i = 0; i < points.length; i++) {
      const k = this._key(points[i]);
      let l = this.map.get(k);
      if (!l) { l = []; this.map.set(k, l); }
      l.push(i);
    }
  }

  _coord(p) {
    return [Math.floor((p[0] - this.min[0]) / this.cell), Math.floor((p[1] - this.min[1]) / this.cell), Math.floor((p[2] - this.min[2]) / this.cell)];
  }

  _key(p) {
    const c = this._coord(p);
    return c[0] * 73856093 ^ c[1] * 19349663 ^ c[2] * 83492791; // may collide; buckets verified by distance anyway
  }

  _keyc(x, y, z) { return x * 73856093 ^ y * 19349663 ^ z * 83492791; }

  /** Indices of points with |p - q| < r (strict). */
  within(q, r) {
    const out = [];
    const c = this._coord(q);
    const n = Math.ceil(r / this.cell);
    const r2 = r * r;
    const pts = this.points;
    for (let x = c[0] - n; x <= c[0] + n; x++) for (let y = c[1] - n; y <= c[1] + n; y++) for (let z = c[2] - n; z <= c[2] + n; z++) {
      const l = this.map.get(this._keyc(x, y, z));
      if (!l) continue;
      for (const i of l) {
        const p = pts[i];
        const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
        if (dx * dx + dy * dy + dz * dz < r2) out.push(i);
      }
    }
    return out;
  }

  /** Nearest point index (or -1). Optional maxDist limits the search. */
  nearest(q, maxDist = Infinity) {
    const c = this._coord(q);
    let best = -1, bestD2 = maxDist * maxDist;
    const pts = this.points;
    const maxRing = Math.min(64, Math.ceil(Math.min(maxDist, 1e6) / this.cell) + 1);
    for (let ring = 0; ring <= maxRing; ring++) {
      // once we found something within (ring-1)*cell we can stop
      if (best >= 0 && Math.sqrt(bestD2) < (ring - 1) * this.cell) break;
      for (let x = c[0] - ring; x <= c[0] + ring; x++) for (let y = c[1] - ring; y <= c[1] + ring; y++) for (let z = c[2] - ring; z <= c[2] + ring; z++) {
        if (Math.max(Math.abs(x - c[0]), Math.abs(y - c[1]), Math.abs(z - c[2])) !== ring) continue;
        const l = this.map.get(this._keyc(x, y, z));
        if (!l) continue;
        for (const i of l) {
          const p = pts[i];
          const dx = p[0] - q[0], dy = p[1] - q[1], dz = p[2] - q[2];
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 < bestD2 || (d2 === bestD2 && best >= 0 && i < best)) { bestD2 = d2; best = i; }
        }
      }
      if (ring > maxRing) break;
    }
    return best;
  }
}
