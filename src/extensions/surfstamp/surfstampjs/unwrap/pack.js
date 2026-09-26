// Rectangle packing (skyline bottom-left) aiming for a roughly square layout.

/**
 * @param {Array<{width:number,height:number}>} boxes
 * @param {{margin?:number, targetWidth?:number, keepOrder?:boolean}} opts margin is added on every side
 * @returns {Array<{x:number,y:number}>} top-left corner of each (margin-inclusive) box, in input order
 */
export function packBoxes(boxes, opts = {}) {
  const margin = opts.margin ?? 0;
  const items = boxes.map((b, i) => ({ i, w: b.width + 2 * margin, h: b.height + 2 * margin }));
  if (!items.length) return [];
  const order = opts.keepOrder ? items : items.slice().sort((a, b) => b.h - a.h || b.w - a.w);
  let area = 0, maxW = 0;
  for (const it of items) { area += it.w * it.h; maxW = Math.max(maxW, it.w); }
  let width = opts.targetWidth || Math.max(maxW, Math.sqrt(area) * 1.1);
  let best = null;
  for (let pass = 0; pass < 4; pass++) {
    const res = skyline(order, width);
    const side = Math.max(res.width, res.height);
    if (!best || side < best.side) best = { side, pos: res.pos };
    // aim for a square next time
    width = Math.max(maxW, Math.sqrt(res.width * res.height));
  }
  const out = new Array(items.length);
  for (const it of order) out[it.i] = best.pos.get(it.i);
  return out;
}

function skyline(order, width) {
  // skyline as a list of segments {x, y, w}
  let sky = [{ x: 0, y: 0, w: width }];
  const pos = new Map();
  let maxX = 0, maxY = 0;
  for (const it of order) {
    // find the lowest position where the box fits
    let bestY = Infinity, bestX = 0, bestIdx = -1;
    for (let i = 0; i < sky.length; i++) {
      const x = sky[i].x;
      if (x + it.w > width + 1e-9) continue;
      // height needed: max of segments spanned
      let y = 0, span = 0, j = i;
      while (j < sky.length && span < it.w) { y = Math.max(y, sky[j].y); span += sky[j].w; j++; }
      if (span < it.w - 1e-9 && x + it.w > width + 1e-9) continue;
      if (y < bestY || (y === bestY && x < bestX)) { bestY = y; bestX = x; bestIdx = i; }
    }
    if (bestIdx < 0) { // wider than the strip: put it on top
      bestX = 0; bestY = 0; for (const s of sky) bestY = Math.max(bestY, s.y);
    }
    pos.set(it.i, { x: bestX, y: bestY });
    maxX = Math.max(maxX, bestX + it.w); maxY = Math.max(maxY, bestY + it.h);
    // update skyline
    const nsky = [];
    const x0 = bestX, x1 = bestX + it.w, top = bestY + it.h;
    let inserted = false;
    for (const s of sky) {
      const sx0 = s.x, sx1 = s.x + s.w;
      if (sx1 <= x0 || sx0 >= x1) { nsky.push(s); continue; }
      if (sx0 < x0) nsky.push({ x: sx0, y: s.y, w: x0 - sx0 });
      if (!inserted) { nsky.push({ x: x0, y: top, w: it.w }); inserted = true; }
      if (sx1 > x1) nsky.push({ x: x1, y: s.y, w: sx1 - x1 });
    }
    if (!inserted) nsky.push({ x: x0, y: top, w: it.w });
    nsky.sort((a, b) => a.x - b.x);
    // merge equal-height neighbours
    sky = [];
    for (const s of nsky) {
      const last = sky[sky.length - 1];
      if (last && Math.abs(last.y - s.y) < 1e-9) last.w += s.w; else sky.push({ ...s });
    }
  }
  return { pos, width: maxX, height: maxY };
}
