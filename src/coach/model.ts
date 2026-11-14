// Small multilayer perceptrons (ReLU hidden layers, linear output), stored as JSON.
export interface Net {
  mean: number[];
  std: number[];
  /** layers[i] = { w: rows x cols flattened (out x in), b } */
  layers: { w: number[]; b: number[]; nin: number; nout: number }[];
}
export interface ModelFile {
  /** ensemble of position-value nets; outputs: [pWin, pLose, ptsWin/50, ptsLose/50] */
  v: Net[];
  /** ensemble of knock-value nets, same outputs */
  k: Net[];
  meta: Record<string, unknown>;
}

interface Compiled {
  mean: Float32Array;
  istd: Float32Array;
  w: Float32Array[];
  b: Float32Array[];
  nin: number[];
  nout: number[];
  buf: Float32Array[];
}

export function compile(net: Net): Compiled {
  return {
    mean: Float32Array.from(net.mean),
    istd: Float32Array.from(net.std.map((s) => 1 / (s || 1))),
    w: net.layers.map((l) => Float32Array.from(l.w)),
    b: net.layers.map((l) => Float32Array.from(l.b)),
    nin: net.layers.map((l) => l.nin),
    nout: net.layers.map((l) => l.nout),
    buf: [new Float32Array(net.mean.length), ...net.layers.map((l) => new Float32Array(l.nout))],
  };
}

/** Forward pass. Returns the net's internal output buffer (copy it if you need to keep it). */
export function forward(c: Compiled, x: ArrayLike<number>): Float32Array {
  let a = c.buf[0];
  for (let i = 0; i < a.length; i++) a[i] = (x[i] - c.mean[i]) * c.istd[i];
  const L = c.w.length;
  for (let l = 0; l < L; l++) {
    const w = c.w[l];
    const b = c.b[l];
    const nin = c.nin[l];
    const nout = c.nout[l];
    const o = c.buf[l + 1];
    for (let j = 0; j < nout; j++) {
      let s = b[j];
      const off = j * nin;
      for (let i = 0; i < nin; i++) s += w[off + i] * a[i];
      o[j] = l < L - 1 && s < 0 ? 0 : s;
    }
    a = o;
  }
  return a;
}

export interface Estimate {
  /** expected points for the mover (positive good) */
  ev: number;
  pWin: number;
  pLose: number;
  ptsWin: number;
  ptsLose: number;
  /** ev of each ensemble member, for uncertainty */
  members: number[];
}

export class Ensemble {
  nets: Compiled[];
  constructor(nets: Net[]) {
    this.nets = nets.map(compile);
  }
  /** Mean expected points only (fast path, first `use` members). */
  ev(x: ArrayLike<number>, use = this.nets.length): number {
    let s = 0;
    for (let i = 0; i < use; i++) {
      const o = forward(this.nets[i], x);
      s += (o[2] - o[3]) * 50;
    }
    return s / use;
  }
  estimate(x: ArrayLike<number>): Estimate {
    let pw = 0, pl = 0, w = 0, l = 0;
    const members: number[] = [];
    for (const n of this.nets) {
      const o = forward(n, x);
      pw += o[0];
      pl += o[1];
      w += o[2] * 50;
      l += o[3] * 50;
      members.push((o[2] - o[3]) * 50);
    }
    const k = this.nets.length;
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    return { ev: (w - l) / k, pWin: clamp(pw / k), pLose: clamp(pl / k), ptsWin: Math.max(0, w / k), ptsLose: Math.max(0, l / k), members };
  }
}
