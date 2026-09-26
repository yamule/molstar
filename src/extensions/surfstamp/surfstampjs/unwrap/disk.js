// Topology repair: turn a face group into a topological disk (single boundary loop, genus 0).
/**
 * Make a face group a topological disk: cut closed surfaces open, fill holes, cut handles, slit pockets.
 * Returns the (possibly extended by dummy faces) face list, or null if the group is empty.
 */
export function makeDisk(wm, group, log) {
  let g = group.slice();
  for (let guard = 0; guard < 20; guard++) {
    wm.splitNonManifoldVertices(g);
    let topo = wm.topo(g);
    let loops = topo.boundaryLoops();
    if (!loops.length) {
      // closed surface: slit along the longest geodesic path
      const path = wm.longestPath(g, topo);
      if (path.length < 2) { // single face or degenerate: detach one face
        const f = wm.faces[g[0]];
        for (let m = 0; m < 3; m++) f[m] = wm.cloneVertex(f[m]);
      } else wm.cutPath(path, g, { loop: false });
      continue;
    }
    if (loops.length > 1) {
      const dummies = wm.fillHoles(g);
      g.push(...dummies);
      topo = wm.topo(g);
      loops = topo.boundaryLoops();
    }
    // genus check: disk has chi = 1 with a single loop
    const eu = wm.euler(g);
    if (eu.loops === 1 && eu.chi < 1) {
      const loop = wm.findHandleLoop(g);
      if (loop && loop.length >= 3) { wm.cutPath(loop, g, { loop: true }); continue; }
    }
    if (eu.loops !== 1) continue;
    // pocket check: outline too short for the depth
    const outline = loops[0];
    const L = wm.loopLength(outline);
    const fromOutline = wm.dijkstra(outline, topo);
    let deep = -1, deepV = -1;
    for (const [v, d] of fromOutline.dist) if (d > deep) { deep = d; deepV = v; }
    if (g.length >= 5 && deepV >= 0 && L < deep * 2 * Math.PI * 0.8) {
      const path = wm.shortestPath(deepV, fromOutline.src.get(deepV), topo);
      if (path && path.length >= 3) { wm.cutPath(path, g, { loop: false }); log && log(`  pocket slit (${path.length} vertices)`); continue; }
    }
    return g;
  }
  return g;
}

