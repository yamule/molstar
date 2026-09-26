// PDB format reader (ATOM/HETATM/MODEL/ENDMDL/TER) and residue bookkeeping.
// Browser build of SurfStampJS: no file access (use PDBData.parse(text) or build the data from mol* structures).

export const AMINO3TO1 = {
  ALA: 'A', ARG: 'R', ASN: 'N', ASP: 'D', CYS: 'C', GLN: 'Q', GLU: 'E', GLY: 'G', HIS: 'H', ILE: 'I',
  LEU: 'L', LYS: 'K', MET: 'M', PHE: 'F', PRO: 'P', SER: 'S', THR: 'T', TRP: 'W', TYR: 'Y', VAL: 'V',
  MSE: 'M', SEC: 'U', PYL: 'O', ASX: 'B', GLX: 'Z', UNK: 'X',
};
export const NUCLEOTIDES = new Set(['DA', 'DT', 'DG', 'DC', 'DU', 'DI', 'DN', 'A', 'G', 'C', 'U', 'I', 'N', 'T']);
export const WATER = new Set(['HOH', 'DOD', 'WAT', 'H2O']);
const NUC_BACKBONE = new Set(['P', "O3'", "C3'", "C4'", "C5'", "O5'"]);
const AA_BACKBONE = new Set(['N', 'O', 'C', 'CA']);

/** Element symbol guess from atom name when columns 77-78 are absent. */
export function guessElement(atomName, resName, hetatm) {
  const n = atomName.trim();
  if (!n) return 'C';
  const two = n.slice(0, 2).toUpperCase();
  // Standard PDB: element is right-justified in columns 13-14; a 4-char name starting in column 13 whose
  // first char is a digit/H is hydrogen.
  if (atomName.length === 4 && /^[0-9]/.test(atomName[0])) return 'H';
  if (atomName.length === 4 && atomName[0] === 'H' && !hetatm) return 'H';
  if (atomName[0] !== ' ' && atomName.length === 4) {
    // starts at column 13 -> two-letter element
    if (['FE', 'ZN', 'MG', 'CA', 'MN', 'CU', 'CL', 'BR', 'NA', 'CO', 'NI', 'SE', 'CD', 'HG'].includes(two)) return two;
  }
  if (hetatm && ['FE', 'ZN', 'MG', 'MN', 'CU', 'CL', 'BR', 'NA', 'CO', 'NI', 'SE', 'CD', 'HG'].includes(two) && atomName[0] !== ' ') return two;
  return n[0].toUpperCase();
}

export class PDBAtom {
  constructor() {
    this.serial = 0; this.name = ''; this.altLoc = ''; this.resName = ''; this.chain = ''; this.resSeq = 0;
    this.iCode = ''; this.x = 0; this.y = 0; this.z = 0; this.occupancy = 1; this.bfactor = 0; this.element = 'C';
    this.hetatm = false; this.residue = null; this.model = 1;
  }
  get pos() { return [this.x, this.y, this.z]; }
  isBackbone() {
    if (NUCLEOTIDES.has(this.resName)) return NUC_BACKBONE.has(this.name);
    return AA_BACKBONE.has(this.name) && this.element !== 'CA';
  }
}

export class PDBResidue {
  constructor(chain, resName, resSeq, iCode, model) {
    this.chain = chain; this.resName = resName; this.resSeq = resSeq; this.iCode = iCode; this.model = model;
    this.atoms = [];
    this.index = -1; // index within chain
    this.chainBreakBefore = false; this.chainBreakAfter = false; this.missingAtoms = false; this.terminal = false;
  }
  key() { return `${this.model}|${this.chain}|${this.resSeq}|${this.iCode}|${this.resName}`; }
  isAminoAcid() { return this.resName in AMINO3TO1; }
  isNucleotide() { return NUCLEOTIDES.has(this.resName); }
  isWater() { return WATER.has(this.resName); }
  oneLetter() {
    if (this.resName in AMINO3TO1) return AMINO3TO1[this.resName];
    if (this.isNucleotide()) return this.resName.replace(/^D/, '');
    return this.resName;
  }
  atom(name) { return this.atoms.find(a => a.name === name) || null; }
  label({ oneLetter = false, chainName = true } = {}) {
    const rn = oneLetter ? this.oneLetter() : this.resName;
    const num = `${this.resSeq}${this.iCode.trim()}`;
    return (chainName && this.chain.trim() ? this.chain.trim() + ':' : '') + rn + num;
  }
}

export class PDBData {
  constructor() {
    this.atoms = [];
    this.residues = [];
    this.chains = new Map(); // chain id -> residues (ordered)
    this.name = '';
  }

  static parse(text, { firstModelOnly = true, keepAltLoc = 'first' } = {}) {
    const pdb = new PDBData();
    let model = 1;
    let seenModel = false;
    const resMap = new Map();
    let stop = false;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (stop) break;
      const rec = line.slice(0, 6);
      if (rec === 'MODEL ') { seenModel = true; model = parseInt(line.slice(10, 14)) || model; continue; }
      if (rec === 'ENDMDL') { if (firstModelOnly) stop = true; continue; }
      if (rec !== 'ATOM  ' && rec !== 'HETATM') continue;
      const a = new PDBAtom();
      a.hetatm = rec === 'HETATM';
      a.serial = parseInt(line.slice(6, 11)) || 0;
      a.name = line.slice(12, 16).trim();
      a.altLoc = line.slice(16, 17).trim();
      a.resName = line.slice(17, 20).trim();
      a.chain = line.slice(21, 22);
      a.resSeq = parseInt(line.slice(22, 26)) || 0;
      a.iCode = line.slice(26, 27).trim();
      a.x = parseFloat(line.slice(30, 38));
      a.y = parseFloat(line.slice(38, 46));
      a.z = parseFloat(line.slice(46, 54));
      const occ = parseFloat(line.slice(54, 60)); a.occupancy = isNaN(occ) ? 1 : occ;
      const bf = parseFloat(line.slice(60, 66)); a.bfactor = isNaN(bf) ? 0 : bf;
      const el = line.slice(76, 78).trim();
      a.element = el ? el.toUpperCase() : guessElement(line.slice(12, 16), a.resName, a.hetatm);
      a.model = model;
      if (isNaN(a.x) || isNaN(a.y) || isNaN(a.z)) continue;
      const rkey = `${model}|${a.chain}|${a.resSeq}|${a.iCode}|${a.resName}`;
      let res = resMap.get(rkey);
      if (!res) {
        res = new PDBResidue(a.chain, a.resName, a.resSeq, a.iCode, model);
        resMap.set(rkey, res);
        pdb.residues.push(res);
      }
      if (keepAltLoc === 'first' && a.altLoc) {
        const dup = res.atoms.find(b => b.name === a.name);
        if (dup) { if (a.occupancy > dup.occupancy) { Object.assign(dup, a, { residue: res }); } continue; }
      }
      a.residue = res;
      res.atoms.push(a);
      pdb.atoms.push(a);
    }
    void seenModel;
    pdb.index();
    return pdb;
  }

  /** (Re)build the chain map and residue annotations after atoms/residues were added. */
  index() {
    this.chains = new Map();
    for (const r of this.residues) {
      let l = this.chains.get(r.chain);
      if (!l) { l = []; this.chains.set(r.chain, l); }
      r.index = l.length;
      l.push(r);
    }
    this._annotateBreaks();
  }

  /** Mark chain breaks / terminals / missing atoms (used to gray out labels). */
  _annotateBreaks() {
    for (const [, list] of this.chains) {
      const poly = list.filter(r => r.isAminoAcid() || r.isNucleotide());
      for (let i = 0; i < poly.length; i++) {
        const r = poly[i];
        if (r.isAminoAcid()) {
          for (const n of ['N', 'CA', 'C', 'O']) if (!r.atom(n)) r.missingAtoms = true;
        }
        if (i === 0) { r.terminal = true; r.chainBreakBefore = true; }
        if (i === poly.length - 1) { r.terminal = true; r.chainBreakAfter = true; }
        if (i > 0) {
          const p = poly[i - 1];
          let connected = false;
          if (r.isAminoAcid() && p.isAminoAcid()) {
            const c = p.atom('C'), n = r.atom('N');
            if (c && n) connected = Math.hypot(c.x - n.x, c.y - n.y, c.z - n.z) < 2.0;
          } else if (r.isNucleotide() && p.isNucleotide()) {
            const o3 = p.atom("O3'"), pp = r.atom('P');
            if (o3 && pp) connected = Math.hypot(o3.x - pp.x, o3.y - pp.y, o3.z - pp.z) < 2.2;
          }
          if (!connected) { r.chainBreakBefore = true; p.chainBreakAfter = true; }
        }
      }
    }
  }

  /** Return a new PDBData containing only atoms passing the filter. */
  filter(fn) {
    const out = new PDBData();
    out.name = this.name;
    const resMap = new Map();
    for (const a of this.atoms) {
      if (!fn(a)) continue;
      const k = a.residue.key();
      let r = resMap.get(k);
      if (!r) {
        r = new PDBResidue(a.chain, a.resName, a.resSeq, a.iCode, a.model);
        resMap.set(k, r);
        out.residues.push(r);
      }
      const b = Object.assign(new PDBAtom(), a, { residue: r });
      r.atoms.push(b);
      out.atoms.push(b);
    }
    out.index();
    return out;
  }

  removeWater() { return this.filter(a => !WATER.has(a.resName)); }
  removeHetatm() { return this.filter(a => !a.hetatm); }
  removeHydrogens() { return this.filter(a => a.element !== 'H' && a.element !== 'D'); }
}
