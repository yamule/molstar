// Colour schemes (ClustalX-like residue colours, CPK atoms, hydropathy, isoelectric point, chain colours)
// and the colour-scheme text parser (same line format as SurfStamp).

const W = [255, 255, 255], K = [0, 0, 0];

export const DEFAULT_RESIDUE_COLORS = {
  ALA: [25, 127, 229], CYS: [229, 127, 127], ASP: [204, 76, 204], GLU: [204, 76, 204], PHE: [25, 127, 229],
  GLY: [229, 153, 76], HIS: [25, 178, 178], ILE: [25, 127, 229], LYS: [229, 51, 25], LEU: [25, 127, 229],
  MET: [25, 127, 229], ASN: [25, 204, 25], PRO: [204, 204, 0], GLN: [25, 204, 25], ARG: [229, 51, 25],
  SER: [25, 204, 25], THR: [25, 204, 25], VAL: [25, 127, 229], TRP: [25, 127, 229], TYR: [25, 178, 178],
  A: [229, 51, 25], U: [25, 204, 25], T: [25, 204, 25], C: [25, 127, 229], G: [229, 153, 76],
  DA: [229, 51, 25], DT: [25, 204, 25], DC: [25, 127, 229], DG: [229, 153, 76],
};

export const DEFAULT_ATOM_COLORS = {
  H: [[255, 255, 255], K], C: [[255, 255, 255], K], N: [[34, 51, 255], W], O: [[255, 34, 0], W], F: [[31, 240, 31], W],
  CL: [[31, 240, 31], W], BR: [[153, 34, 0], W], I: [[102, 0, 187], W], HE: [[0, 255, 255], W], NE: [[0, 255, 255], W],
  AR: [[0, 255, 255], W], XE: [[0, 255, 255], W], KR: [[0, 255, 255], W], P: [[255, 153, 0], W], S: [[255, 229, 34], K],
  B: [[255, 170, 119], W], LI: [[119, 0, 255], W], NA: [[119, 0, 255], W], K: [[119, 0, 255], W], RB: [[119, 0, 255], W],
  CS: [[119, 0, 255], W], FR: [[119, 0, 255], W], BE: [[0, 119, 0], W], MG: [[0, 119, 0], W], CA: [[0, 119, 0], W],
  SR: [[0, 119, 0], W], BA: [[0, 119, 0], W], RA: [[0, 119, 0], W], TI: [[153, 153, 153], W], FE: [[221, 119, 0], W],
};

export const HYDROPATHY_COLORS = {
  GLY: [255, 116, 116], PRO: [255, 152, 152], ALA: [255, 64, 64], ILE: [255, 0, 0], TYR: [255, 142, 142],
  THR: [255, 123, 123], VAL: [255, 7, 7], SER: [255, 125, 125], ASP: [255, 219, 219], LYS: [255, 233, 233],
  TRP: [255, 128, 128], ASN: [255, 219, 219], ARG: [255, 255, 255], GLN: [255, 219, 219], HIS: [255, 209, 209],
  CYS: [255, 47, 47], PHE: [255, 40, 40], GLU: [255, 219, 219], LEU: [255, 16, 16], MET: [255, 61, 61],
};

export const ISOELECTRIC_COLORS = {
  GLY: [[243, 243, 255], K], VAL: [[243, 243, 255], K], PRO: [[226, 226, 255], K], GLN: [[255, 247, 247], K],
  GLU: [[255, 38, 38], K], ALA: [[241, 241, 255], K], MET: [[255, 255, 255], K], ARG: [[0, 0, 255], W],
  ASN: [[255, 226, 226], K], LEU: [[242, 242, 255], K], PHE: [[255, 232, 232], K], SER: [[255, 249, 249], K],
  ASP: [[255, 0, 0], K], TRP: [[247, 247, 255], K], ILE: [[240, 240, 255], K], LYS: [[51, 51, 255], W],
  THR: [[255, 248, 248], K], TYR: [[255, 248, 248], K], HIS: [[161, 161, 255], K], CYS: [[255, 195, 195], K],
};

const CHAIN_TABLE = `A 0,255,0 W|B 0,255,255 K|C 255,0,255 K|D 255,255,0 K|E 255,0,0 W|F 0,0,255 W|G 255,215,0 K|H 0,191,255 K|I 255,69,0 W|J 255,165,0 K|K 255,140,0 K|L 127,255,0 W|M 0,255,127 W|N 0,250,154 K|O 124,252,0 W|P 0,206,209 K|Q 0,0,205 W|R 255,20,147 K|S 30,144,255 K|T 148,0,211 W|U 220,20,60 W|V 173,255,47 K|W 255,99,71 K|X 218,165,32 K|Y 138,43,226 K|Z 255,127,80 K|a 210,105,30 W|b 199,21,133 W|c 50,205,50 W|d 184,134,11 W|e 64,224,208 K|f 65,105,225 K|g 178,34,34 W|h 32,178,170 W|i 139,0,139 W|j 139,0,0 W|k 0,139,139 W|l 0,0,139 W|m 154,205,50 K|n 153,50,204 K|o 72,209,204 K|p 255,105,180 K|q 250,128,114 K|r 244,164,96 K|s 128,128,0 W|t 128,0,128 W|u 128,0,0 W|v 0,128,128 W|w 0,128,0 W|x 0,0,128 W|y 123,104,238 K|z 165,42,42 W|1 205,133,63 K|2 100,149,237 K|3 255,160,122 K|4 186,85,211 K|5 75,0,130 W|6 205,92,92 K|7 127,255,212 K|8 240,128,128 K|9 238,130,238 K`;

export const CHAIN_COLORS = (() => {
  const m = {};
  for (const e of CHAIN_TABLE.split('|')) {
    const [id, rgb, t] = e.split(' ');
    m[id] = [rgb.split(',').map(Number), t === 'W' ? W : K];
  }
  return m;
})();

export const GRAY_CHAINBREAK = [80, 80, 80];
export const GRAY_MISSING = [128, 128, 128];

/**
 * A colour scheme = ordered list of rules; the LAST matching rule wins (as in SurfStamp).
 * rule: {chain?, residue?, residueNumber?, atom?, model?, background?, text?, outline?}
 */
export class ColorScheme {
  constructor(rules = []) { this.rules = rules; }

  /** Parse SurfStamp colour scheme text (tab separated key=value per line). */
  static parse(text) {
    const rules = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const rule = {};
      for (const tok of line.split(/\t+/)) {
        const m = tok.match(/^([a-z_]+)=(.*)$/);
        if (!m) continue;
        const [, k, v] = m;
        const rgb = () => v.split(',').map(s => parseInt(s.trim()));
        if (k === 'background_color') rule.background = rgb();
        else if (k === 'text_color') rule.text = rgb();
        else if (k === 'outline_color') rule.outline = rgb();
        else if (k === 'residue') rule.residue = v.trim();
        else if (k === 'residue_number') rule.residueNumber = v.trim();
        else if (k === 'chain') rule.chain = v.trim();
        else if (k === 'atom') rule.atom = v.trim().toUpperCase();
        else if (k === 'model') rule.model = v.trim();
      }
      rules.push(rule);
    }
    return new ColorScheme(rules);
  }

  static preset(id) {
    const rules = [];
    if (id === 0 || id == null) {
      for (const [r, bg] of Object.entries(DEFAULT_RESIDUE_COLORS)) rules.push({ residue: r, background: bg, text: W, outline: K });
      for (const [a, [bg, t]] of Object.entries(DEFAULT_ATOM_COLORS)) rules.push({ atom: a, background: bg, text: t, outline: K });
    } else if (id === 1) {
      for (const [r, bg] of Object.entries(HYDROPATHY_COLORS)) rules.push({ residue: r, background: bg, text: K, outline: K });
    } else if (id === 2) {
      for (const [r, [bg, t]] of Object.entries(ISOELECTRIC_COLORS)) rules.push({ residue: r, background: bg, text: t, outline: K });
    } else if (id === 3) {
      for (const [a, [bg, t]] of Object.entries(DEFAULT_ATOM_COLORS)) rules.push({ atom: a, background: bg, text: t, outline: K });
    } else if (id === 7 || id === 'chain') {
      for (const [c, [bg, t]] of Object.entries(CHAIN_COLORS)) rules.push({ chain: c, background: bg, text: t, outline: K });
    } else {
      throw new Error('unknown colour preset ' + id);
    }
    return new ColorScheme(rules);
  }

  /**
   * Resolve colours for a residue (or atom). Returns {background, text, outline}.
   * @param {{chain?:string, residue?:string, residueNumber?:string|number, atom?:string, model?:string|number}} q
   */
  resolve(q, defaults = { background: [180, 180, 180], text: [0, 0, 0], outline: [0, 0, 0] }) {
    const out = { ...defaults };
    const eq = (rv, qv) => rv == null || (qv != null && String(qv).trim() === String(rv).trim());
    for (const r of this.rules) {
      if (!eq(r.residue, q.residue) || !eq(r.chain, q.chain) || !eq(r.residueNumber, q.residueNumber) || !eq(r.model, q.model)) continue;
      if (r.atom != null && (q.atom == null || String(q.atom).toUpperCase() !== r.atom)) continue;
      if (r.background) out.background = r.background;
      if (r.text) out.text = r.text;
      if (r.outline) out.outline = r.outline;
    }
    return out;
  }
}

/** Linear two-segment gradient used for B-factor / occupancy colouring. */
export function gradientColor(value, min, max, cMin = [255, 255, 255], cMid = [255, 128, 128], cMax = [255, 0, 0]) {
  if (!(max > min)) return cMid.slice();
  const mid = (max + min) / 2;
  const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  if (value <= min) return cMin.slice();
  if (value >= max) return cMax.slice();
  return value < mid ? lerp(cMin, cMid, (value - min) / (mid - min)) : lerp(cMid, cMax, (value - mid) / (max - mid));
}

export function luminance(c) { return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; }
