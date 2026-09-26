// Build decoration objects (label + colours + face indices) from a PDB structure and a surface mesh.
import { mapFacesToStructure, removeJaggy } from './mapping.js';
import { ColorScheme, GRAY_CHAINBREAK, GRAY_MISSING, gradientColor, luminance, CHAIN_COLORS } from './colors.js';

/**
 * @param {import('./pdb.js').PDBData} pdb
 * @param {import('./mesh.js').SurfaceMesh} mesh
 * @param {object} opts
 * @param {'residue'|'atom'|'chain'} [opts.mode='residue']
 * @param {ColorScheme|number|string} [opts.scheme=0] ColorScheme, preset id, or scheme text (SurfStamp format)
 * @param {boolean} [opts.oneLetter=false]
 * @param {boolean} [opts.chainName] include chain id in labels (default: only when more than one chain)
 * @param {boolean} [opts.colorMissing=true] gray out chain breaks / terminals / residues with missing atoms
 * @param {boolean} [opts.removeJaggy=false]
 * @param {boolean} [opts.force=false] ignore the 5 A face-atom distance check
 * @param {number} [opts.exvalueMin], [opts.exvalueMax] value range for presets 4 (B-factor) and 5 (occupancy)
 * @returns {Array} decorations for createTexturedObject
 */
export function buildResidueDecorations(pdb, mesh, opts = {}) {
  const mode = opts.mode || 'residue';
  let scheme = opts.scheme;
  const presetId = typeof scheme === 'number' ? scheme : null;
  if (scheme == null) scheme = ColorScheme.preset(0);
  else if (typeof scheme === 'number') scheme = (scheme === 4 || scheme === 5) ? ColorScheme.preset(0) : ColorScheme.preset(scheme);
  else if (typeof scheme === 'string') scheme = ColorScheme.parse(scheme);
  const { groups } = mapFacesToStructure(mesh, pdb, { mode: mode === 'atom' ? 'atom' : 'residue', maxDistance: opts.force ? 0 : 5 });
  if (opts.removeJaggy) removeJaggy(mesh, groups);
  const chainName = opts.chainName != null ? opts.chainName : pdb.chains.size > 1;
  const decos = [];
  if (mode === 'chain') {
    const byChain = new Map();
    for (const [res, faces] of groups) { let l = byChain.get(res.chain); if (!l) { l = []; byChain.set(res.chain, l); } l.push(...faces); }
    for (const [chain, faces] of byChain) {
      const c = scheme.resolve({ chain: chain.trim() }, { background: (CHAIN_COLORS[chain.trim()] || [[180, 180, 180]])[0], text: [0, 0, 0], outline: [0, 0, 0] });
      decos.push({ faces, text: chain.trim() || 'chain', textColor: c.text, backgroundColor: c.background, outlineColor: c.outline, sortKey: chain });
    }
    return decos;
  }
  // value range for B-factor / occupancy presets
  let vmin = Infinity, vmax = -Infinity;
  if (presetId === 4 || presetId === 5) {
    for (const a of pdb.atoms) { const v = presetId === 4 ? a.bfactor : a.occupancy; if (v < vmin) vmin = v; if (v > vmax) vmax = v; }
    if (opts.exvalueMin != null) vmin = opts.exvalueMin;
    if (opts.exvalueMax != null) vmax = opts.exvalueMax;
  }
  for (const [key, faces] of groups) {
    const res = mode === 'atom' ? key.residue : key;
    const atom = mode === 'atom' ? key : null;
    const q = { chain: res.chain.trim(), residue: res.resName, residueNumber: `${res.resSeq}${res.iCode}`, model: res.model };
    if (atom) q.atom = atom.element;
    let c = scheme.resolve(q);
    if (presetId === 3 && !atom) c = scheme.resolve(q);
    if (presetId === 4 || presetId === 5) {
      const val = atom ? (presetId === 4 ? atom.bfactor : atom.occupancy)
        : res.atoms.reduce((s, a) => s + (presetId === 4 ? a.bfactor : a.occupancy), 0) / (res.atoms.length || 1);
      const bg = gradientColor(val, vmin, vmax, opts.exvalueColorMin, opts.exvalueColorMedian, opts.exvalueColorMax);
      c = { background: bg, text: luminance(bg) > 128 ? [0, 0, 0] : [255, 255, 255], outline: [0, 0, 0] };
    }
    if (presetId === 7) {
      const list = pdb.chains.get(res.chain) || [res];
      const pos = list.length > 1 ? res.index / list.length : 0;
      const base = (CHAIN_COLORS[res.chain.trim()] || [[128, 128, 128]])[0];
      let bg;
      if (pos <= 0.5) { const f = pos * 1.9 + 0.05; bg = base.map(x => Math.round(x * f)); }
      else bg = base.map(x => Math.min(255, Math.round((pos - 0.5) * 400 + x)));
      c = { background: bg, text: luminance(bg) > 128 ? [0, 0, 0] : [255, 255, 255], outline: [0, 0, 0] };
    }
    if (opts.colorMissing !== false && (res.isAminoAcid() || res.isNucleotide())) {
      if (res.chainBreakBefore || res.chainBreakAfter || res.terminal) c = { background: GRAY_CHAINBREAK, text: [255, 255, 255], outline: c.outline };
      else if (res.missingAtoms) c = { background: GRAY_MISSING, text: [255, 255, 255], outline: c.outline };
    }
    let text = res.label({ oneLetter: !!opts.oneLetter, chainName });
    if (atom) text = `${text}:${atom.name}`;
    if (opts.modelName && pdb.atoms.some(a => a.model !== 1)) text = `${res.model}:${text}`;
    decos.push({
      faces, text, textColor: c.text, backgroundColor: c.background, outlineColor: c.outline,
      residue: res, atom, sortKey: [res.chain, res.resSeq, res.iCode, atom ? atom.serial : 0],
    });
  }
  decos.sort((a, b) => {
    for (let i = 0; i < a.sortKey.length; i++) { if (a.sortKey[i] < b.sortKey[i]) return -1; if (a.sortKey[i] > b.sortKey[i]) return 1; }
    return 0;
  });
  return decos;
}
