import { type Card, type Rng, VALUE } from '../engine/cards';
import { type Action, HandState } from '../engine/hand';
import { deadwood, discardDeadwoods } from '../engine/melds';
import { NK, NV, kFeatures, makeCtx, vFeatures, type Ctx } from '../coach/features';
import { DEFAULT_WEIGHTS, holdWeights, type InferenceWeights } from '../coach/mc';
import { Ensemble, type ModelFile } from '../coach/model';
import { UNSEEN, cardStatus, type Policy } from './policy';

export interface Models {
  v: Ensemble;
  k: Ensemble;
}
export const loadModels = (m: ModelFile): Models => ({ v: new Ensemble(m.v), k: new Ensemble(m.k) });

const fv = new Float32Array(NV);
const fk = new Float32Array(NK);
const dws = new Int16Array(11);

export interface DiscardEval {
  /** best action value */
  best: number;
  bestAction: Action;
}

/**
 * Value of holding `hand` (11 cards) and having to discard: the best of every legal
 * discard (model V) and knocking (model K). `members` limits ensemble size for speed.
 */
export function evalDiscardState(hand: readonly Card[], justTaken: Card, ctx: Ctx, m: Models, members: number, drawn: Card = -1): DiscardEval {
  if (deadwood(hand) === 0) return { best: 50 + 20, bestAction: { type: 'biggin' } };
  discardDeadwoods(hand, dws);
  const local = Array.from(dws.subarray(0, hand.length));
  let minDw = 999;
  let minIdx = -1;
  for (let i = 0; i < hand.length; i++) {
    if (hand[i] === justTaken) continue;
    if (local[i] < minDw) {
      minDw = local[i];
      minIdx = i;
    }
  }
  if (minDw === 0) return { best: 25 + 22, bestAction: { type: 'discard', card: hand[minIdx], knock: true } };
  let best = -1e9;
  let bestAction: Action = { type: 'discard', card: hand[minIdx], knock: false };
  for (let i = 0; i < hand.length; i++) {
    const d = hand[i];
    if (d === justTaken) continue;
    const H = hand.filter((_, j) => j !== i);
    vFeatures(H, d, ctx, fv, drawn);
    const v = m.v.ev(fv, members);
    if (v > best) {
      best = v;
      bestAction = { type: 'discard', card: d, knock: false };
    }
  }
  if (minDw <= ctx.limit) {
    const H = hand.filter((_, j) => j !== minIdx);
    kFeatures(H, ctx, fk);
    const kv = m.k.ev(fk, members);
    if (kv > best) {
      best = kv;
      bestAction = { type: 'discard', card: hand[minIdx], knock: true };
    }
  }
  return { best, bestAction };
}

/** Expected value of drawing from the stock: average over the unseen cards that may be next. */
export function evalStockDraw(hand: readonly Card[], ctx: Ctx, m: Models, members: number): number {
  let sum = 0;
  let tot = 0;
  const h11 = hand.slice();
  h11.push(0);
  for (const c of ctx.unseen) {
    const w = 1 - ctx.q[c];
    if (w <= 0) continue;
    h11[hand.length] = c;
    sum += w * evalDiscardState(h11, -1, ctx, m, members, c).best;
    tot += w;
  }
  return tot > 0 ? sum / tot : 0;
}

export interface LearnedOptions {
  /** look one draw ahead when deciding whether to take the pile card (slower, stronger) */
  lookahead?: boolean;
  members?: number;
  weights?: InferenceWeights;
  name?: string;
}

export function makeLearned(m: Models, opt: LearnedOptions = {}): Policy {
  const members = opt.members ?? 1;
  const W = opt.weights ?? DEFAULT_WEIGHTS;
  return {
    name: opt.name ?? (opt.lookahead ? 'Expert' : 'Strong'),
    act(s: HandState, _rng: Rng): Action {
      const p = s.turn;
      const hand = s.hands[p];
      if (s.phase === 'draw') {
        if (s.opening === 2) return { type: 'stock' };
        const top = s.topDiscard;
        const decline: Action = s.opening <= 1 ? { type: 'pass' } : { type: 'stock' };
        if (top < 0) return decline;
        const melds = deadwood([...hand, top]) < deadwood(hand) + VALUE[top];
        if (!opt.lookahead) return melds ? { type: 'take' } : decline;
        const st = cardStatus(s, p);
        const ctx = makeCtx(s, p, st, holdWeights(s, p, W));
        const qStock = evalStockDraw(hand, ctx, m, members);
        const ctxT: Ctx = { ...ctx, myKnown: ctx.myKnown + 1 };
        const qTake = evalDiscardState([...hand, top], top, ctxT, m, members).best;
        return qTake > qStock ? { type: 'take' } : decline;
      }
      const st = cardStatus(s, p);
      const ctx = makeCtx(s, p, st, holdWeights(s, p, W));
      return evalDiscardState(hand, s.justTaken, ctx, m, members).bestAction;
    },
  };
}

export { UNSEEN };
