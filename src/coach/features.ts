import { type Card, VALUE } from '../engine/cards';
import { HandState } from '../engine/hand';
import { arrange, deadwood, discardDeadwoods } from '../engine/melds';
import { MINE, OPP, UNSEEN } from '../bots/policy';

/** Features of the position after the mover discards (and does not knock). */
export const V_FEATURES = [
  'deadwood', 'maxDeadCard', 'deadCards', 'meldHits', 'expDeadwoodNext', 'ginHits', 'knockHits', 'couldKnock',
  'knockLimit', 'stock', 'oppTakes', 'oppKnown', 'myKnown', 'oppHoldChance',
  'discardValue', 'dangerSet', 'dangerRun', 'dangerKnown', 'isDealer',
] as const;
export const NV = V_FEATURES.length;

/** Features of a knock (mover discards and knocks with deadwood > 0). */
export const K_FEATURES = ['deadwood', 'knockLimit', 'stock', 'oppTakes', 'oppKnown', 'layoffCards', 'runMelds', 'setMelds', 'oppHoldChance', 'turns'] as const;
export const NK = K_FEATURES.length;

export interface Ctx {
  /** card status from the mover's view (hand includes the 11th card) */
  st: Uint8Array;
  /** probability each card is in the opponent's hand */
  q: Float64Array;
  unseen: Card[];
  limit: number;
  stock: number;
  oppTakes: number;
  oppKnown: number;
  myKnown: number;
  pUnseen: number;
  isDealer: number;
  turns: number;
}

const tmp = new Int16Array(11);
const inH = new Uint8Array(52);
const rc = new Int8Array(13);

/** Build the shared context for a decision by player p. `st` and `w` come from cardStatus / holdWeights. */
export function makeCtx(s: HandState, p: number, st: Uint8Array, w: Float64Array): Ctx {
  const unseen: Card[] = [];
  let oppKnown = 0;
  let sumW = 0;
  for (let c = 0; c < 52; c++) {
    if (st[c] === UNSEEN) {
      unseen.push(c);
      sumW += w[c];
    } else if (st[c] === OPP) oppKnown++;
  }
  const need = s.hands[1 - p].length - oppKnown;
  const q = new Float64Array(52);
  for (const c of unseen) q[c] = Math.min(1, (need * w[c]) / (sumW || 1));
  for (let c = 0; c < 52; c++) if (st[c] === OPP) q[c] = 1;
  let myKnown = 0;
  const k = s.known[p];
  for (let c = 0; c < 52; c++) if (k[c]) myKnown++;
  return {
    st: st.slice(), q, unseen, limit: s.knockLimit, stock: s.stock.length, oppTakes: s.takes[1 - p], oppKnown, myKnown,
    pUnseen: unseen.length ? Math.min(1, need / unseen.length) : 0, isDealer: s.dealer === p ? 1 : 0, turns: s.turnsTaken,
  };
}

/**
 * Fill `out` (length NV) for holding the 10 cards `H` after discarding `d`.
 * `drawn` is an extra card to treat as no longer unseen (used when looking one draw ahead).
 */
export function vFeatures(H: readonly Card[], d: Card, ctx: Ctx, out: Float32Array | number[], drawn: Card = -1): void {
  const n = H.length;
  discardDeadwoods(H, tmp);
  const dw = deadwood(H);
  let minAfter = dw;
  let nDead = 0;
  for (let i = 0; i < n; i++) {
    if (tmp[i] < minAfter) minAfter = tmp[i];
    if (tmp[i] === dw - VALUE[H[i]]) nDead++;
  }
  const maxDead = dw - minAfter;
  inH.fill(0);
  rc.fill(0);
  for (let i = 0; i < n; i++) {
    inH[H[i]] = 1;
    rc[H[i] % 13]++;
  }
  let meldHits = 0;
  let ginHits = 0;
  let knockHits = 0;
  let sumBest = 0;
  let cnt = 0;
  const hand11 = H.slice();
  hand11.push(0);
  const un = ctx.unseen;
  for (let u = 0; u < un.length; u++) {
    const c = un[u];
    if (c === drawn || c === d) continue;
    const avail = 1 - ctx.q[c]; // chance the card is still in the stock
    const r = c % 13;
    const b = c - r;
    let related = rc[r] >= 2;
    if (!related) {
      const l1 = r >= 1 && inH[b + r - 1];
      const l2 = r >= 2 && inH[b + r - 2];
      const r1 = r <= 11 && inH[b + r + 1];
      const r2 = r <= 10 && inH[b + r + 2];
      related = !!((l1 && l2) || (l1 && r1) || (r1 && r2));
    }
    let bestAfter = Math.min(dw, dw - maxDead + VALUE[c]);
    if (related) {
      hand11[n] = c;
      discardDeadwoods(hand11, tmp);
      let m = 999;
      for (let i = 0; i <= n; i++) if (tmp[i] < m) m = tmp[i];
      if (m < bestAfter) {
        bestAfter = m;
        meldHits += avail;
      }
    }
    if (bestAfter === 0) ginHits += avail;
    if (bestAfter <= ctx.limit) knockHits += avail;
    sumBest += avail * bestAfter;
    cnt += avail;
  }
  // danger of the discard: opponent holdings that meld with it
  const q = ctx.q;
  const r = d % 13;
  const b = d - r;
  let a0 = 0, a1 = 0, a2 = 0, k = 0, known = 0;
  for (let s2 = 0; s2 < 4; s2++) {
    const o = s2 * 13 + r;
    if (o === d) continue;
    const pr = inH[o] ? 0 : q[o];
    if (ctx.st[o] === OPP) known++;
    if (k === 0) a0 = pr;
    else if (k === 1) a1 = pr;
    else a2 = pr;
    k++;
  }
  const qq = (rr: number) => (rr >= 0 && rr < 13 && !inH[b + rr] ? q[b + rr] : 0);
  if (r >= 1 && ctx.st[b + r - 1] === OPP) known++;
  if (r <= 11 && ctx.st[b + r + 1] === OPP) known++;
  out[0] = dw / 10;
  out[1] = maxDead / 10;
  out[2] = nDead / 5;
  out[3] = meldHits / 5;
  out[4] = cnt > 0 ? sumBest / cnt / 10 : dw / 10;
  out[5] = ginHits / 3;
  out[6] = knockHits / 10;
  out[7] = dw <= ctx.limit ? 1 : 0;
  out[8] = ctx.limit / 10;
  out[9] = ctx.stock / 31;
  out[10] = ctx.oppTakes / 3;
  out[11] = ctx.oppKnown / 3;
  out[12] = ctx.myKnown / 3;
  out[13] = ctx.pUnseen;
  out[14] = VALUE[d] / 10;
  out[15] = a0 * a1 + a0 * a2 + a1 * a2;
  out[16] = qq(r - 2) * qq(r - 1) + qq(r - 1) * qq(r + 1) + qq(r + 1) * qq(r + 2);
  out[17] = known / 2;
  out[18] = ctx.isDealer;
}

/** Fill `out` (length NK) for knocking with the 10 cards `H`. */
export function kFeatures(H: readonly Card[], ctx: Ctx, out: Float32Array | number[]): void {
  const a = arrange(H);
  let runs = 0;
  let sets = 0;
  let layoff = 0;
  const st = ctx.st;
  const live = (c: number) => (st[c] === UNSEEN || st[c] === OPP ? ctx.q[c] : 0);
  for (const m of a.melds) {
    if (m[0] % 13 === m[1] % 13) {
      sets++;
      if (m.length === 3) {
        const r = m[0] % 13;
        for (let s2 = 0; s2 < 4; s2++) if (!m.includes(s2 * 13 + r)) layoff += live(s2 * 13 + r);
      }
    } else {
      runs++;
      const lo = m[0];
      const hi = m[m.length - 1];
      if (lo % 13 > 0) layoff += live(lo - 1);
      if (hi % 13 < 12) layoff += live(hi + 1);
    }
  }
  out[0] = a.deadwood / 10;
  out[1] = ctx.limit / 10;
  out[2] = ctx.stock / 31;
  out[3] = ctx.oppTakes / 3;
  out[4] = ctx.oppKnown / 3;
  out[5] = layoff;
  out[6] = runs / 3;
  out[7] = sets / 3;
  out[8] = ctx.pUnseen;
  out[9] = ctx.turns / 20;
}

export { MINE };
