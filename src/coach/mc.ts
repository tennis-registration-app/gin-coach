import { type Card, type Rng, makeRng } from '../engine/cards';
import { type Action, HandState } from '../engine/hand';
import { deadwood } from '../engine/melds';
import { DEFAULT_PARAMS, OPP, UNSEEN, cardStatus, makeHeuristic, scoreDiscards, type HeuristicParams, type Policy } from '../bots/policy';

/**
 * Inference weights: how much more or less likely the opponent is to hold an unseen card,
 * given what they have discarded, declined, and picked up. Values are odds multipliers
 * measured from self-play of the heuristic bot (see sim/calibrate.ts).
 */
export interface InferenceWeights {
  discardedSameRank: number;
  discardedAdjacent: number;
  declinedSameRank: number;
  declinedAdjacent: number;
  pickedSameRank: number;
  pickedAdjacent: number;
  pickedTwoAway: number;
}

export const DEFAULT_WEIGHTS: InferenceWeights = {
  discardedSameRank: 0.45,
  discardedAdjacent: 0.6,
  declinedSameRank: 0.75,
  declinedAdjacent: 0.8,
  pickedSameRank: 2.2,
  pickedAdjacent: 2.2,
  pickedTwoAway: 1.4,
};

export const NO_INFERENCE: InferenceWeights = {
  discardedSameRank: 1,
  discardedAdjacent: 1,
  declinedSameRank: 1,
  declinedAdjacent: 1,
  pickedSameRank: 1,
  pickedAdjacent: 1,
  pickedTwoAway: 1,
};

const wts = new Float64Array(52);

/** Relative likelihood that each unseen card is in the opponent's hand, from player p's view. */
export function holdWeights(s: HandState, p: number, W: InferenceWeights = DEFAULT_WEIGHTS): Float64Array {
  wts.fill(1);
  const o = 1 - p;
  const mulRank = (c: Card, f: number) => {
    const r = c % 13;
    for (let s2 = 0; s2 < 4; s2++) wts[s2 * 13 + r] *= f;
  };
  const mulAdj = (c: Card, f: number, dist: number) => {
    const r = c % 13;
    if (r - dist >= 0) wts[c - dist] *= f;
    if (r + dist < 13) wts[c + dist] *= f;
  };
  for (const c of s.discards[o]) {
    mulRank(c, W.discardedSameRank);
    mulAdj(c, W.discardedAdjacent, 1);
  }
  for (const c of s.declined[o]) {
    mulRank(c, W.declinedSameRank);
    mulAdj(c, W.declinedAdjacent, 1);
  }
  const k = s.known[o];
  for (let c = 0; c < 52; c++) {
    if (!k[c]) continue;
    mulRank(c, W.pickedSameRank);
    mulAdj(c, W.pickedAdjacent, 1);
    mulAdj(c, W.pickedTwoAway, 2);
  }
  return wts;
}

const keyBuf = new Float64Array(52);

/**
 * Sample a full deal consistent with everything player p can see: p's hand, the discard
 * pile and the cards the opponent is known to hold stay fixed; the opponent's other
 * cards and the stock order are drawn at random (weighted by inference).
 */
export function sampleWorld(s: HandState, p: number, rng: Rng, W: InferenceWeights = DEFAULT_WEIGHTS): HandState {
  const st = cardStatus(s, p);
  const w = holdWeights(s, p, W);
  const o = 1 - p;
  const oppHand: Card[] = [];
  const pool: Card[] = [];
  for (let c = 0; c < 52; c++) {
    if (st[c] === OPP) oppHand.push(c);
    else if (st[c] === UNSEEN) {
      pool.push(c);
      // Efraimidis-Spirakis: smallest keys are a weighted sample without replacement
      keyBuf[c] = -Math.log(1 - rng()) / w[c];
    }
  }
  const need = s.hands[o].length - oppHand.length;
  pool.sort((a, b) => keyBuf[a] - keyBuf[b]);
  for (let i = 0; i < need; i++) oppHand.push(pool[i]);
  const stock = pool.slice(need);
  for (let i = stock.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = stock[i];
    stock[i] = stock[j];
    stock[j] = t;
  }
  const world = s.clone();
  world.hands[o] = oppHand;
  world.stock = stock;
  return world;
}

/** Outcome codes for a rollout, from the deciding player's point of view. */
export const OUT = { winKnock: 0, winGin: 1, winUndercut: 2, loseKnock: 3, loseGin: 4, loseUndercut: 5, draw: 6 } as const;

export interface Candidate {
  action: Action;
  /** value per sampled world (points for the deciding player, negative if the opponent scores) */
  values: number[];
  outcomes: number[]; // counts indexed by OUT
}

export interface EvalOptions {
  seed: number;
  rollout?: Policy;
  weights?: InferenceWeights;
}

const defaultRollout = makeHeuristic(DEFAULT_PARAMS, 'rollout');
const dummyRng = makeRng(1);

/** Roll out worlds [from, from+count) for every candidate (same worlds for all: paired comparison). */
export function evaluate(s: HandState, cands: Candidate[], from: number, count: number, opt: EvalOptions): void {
  const p = s.turn;
  const pol = opt.rollout ?? defaultRollout;
  for (let wi = from; wi < from + count; wi++) {
    const world = sampleWorld(s, p, makeRng((opt.seed + wi * 7919) >>> 0), opt.weights);
    for (let ci = 0; ci < cands.length; ci++) {
      const c = cands[ci];
      const sim = cands.length === 1 ? world : world.clone();
      sim.apply(c.action);
      let guard = 0;
      while (sim.phase !== 'over') {
        sim.apply(pol.act(sim, dummyRng));
        if (++guard > 300) break;
      }
      const r = sim.result;
      let v = 0;
      let oc: number = OUT.draw;
      if (r && r.winner >= 0) {
        const mine = r.winner === p;
        v = mine ? r.points : -r.points;
        if (r.kind === 'undercut') oc = mine ? OUT.winUndercut : OUT.loseUndercut;
        else if (r.kind === 'knock') oc = mine ? OUT.winKnock : OUT.loseKnock;
        else oc = mine ? OUT.winGin : OUT.loseGin;
      }
      c.values.push(v);
      c.outcomes[oc]++;
    }
  }
}

export const newCandidate = (action: Action): Candidate => ({ action, values: [], outcomes: [0, 0, 0, 0, 0, 0, 0] });

export const sameAction = (a: Action, b: Action): boolean =>
  a.type === b.type && (a.type !== 'discard' || (a.card === (b as typeof a).card && a.knock === (b as typeof a).knock));

/**
 * Candidate actions worth simulating at this decision. Returns `forced` when one action is
 * clearly right without simulation (gin, big gin, or only one legal move).
 */
export function candidateActions(s: HandState, maxDiscards = 5, params: HeuristicParams = DEFAULT_PARAMS): { actions: Action[]; forced: boolean } {
  if (s.phase === 'draw') {
    if (s.opening === 2) return { actions: [{ type: 'stock' }], forced: true };
    const decline: Action = s.opening <= 1 ? { type: 'pass' } : { type: 'stock' };
    if (s.topDiscard < 0) return { actions: [decline], forced: true };
    return { actions: [{ type: 'take' }, decline], forced: false };
  }
  const hand = s.hands[s.turn];
  if (deadwood(hand) === 0) return { actions: [{ type: 'biggin' }], forced: true };
  const scored = scoreDiscards(s, params);
  const byDw = [...scored].sort((a, b) => a.deadwoodAfter - b.deadwoodAfter || a.score - b.score);
  if (byDw[0].deadwoodAfter === 0) return { actions: [{ type: 'discard', card: byDw[0].card, knock: true }], forced: true };
  const actions: Action[] = [];
  if (byDw[0].deadwoodAfter <= s.knockLimit) actions.push({ type: 'discard', card: byDw[0].card, knock: true });
  for (let i = 0; i < scored.length && i < maxDiscards; i++) actions.push({ type: 'discard', card: scored[i].card, knock: false });
  // always consider the lowest-deadwood discard without knocking
  if (!actions.some((a) => a.type === 'discard' && !a.knock && a.card === byDw[0].card)) actions.push({ type: 'discard', card: byDw[0].card, knock: false });
  return { actions, forced: actions.length === 1 };
}

export function mean(v: number[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i];
  return v.length ? s / v.length : 0;
}

/** Mean and standard error of the paired difference a - b. */
export function pairedDiff(a: number[], b: number[]): { diff: number; se: number } {
  const n = Math.min(a.length, b.length);
  if (n < 2) return { diff: 0, se: Infinity };
  let s = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    s += d;
    ss += d * d;
  }
  const m = s / n;
  const varr = Math.max(0, (ss - n * m * m) / (n - 1));
  return { diff: m, se: Math.sqrt(varr / n) };
}

/** A bot that picks the action with the best simulated average. */
export function makeMcPolicy(worlds: number, name = `Monte Carlo (${worlds})`, opt: Partial<EvalOptions> = {}, valueFn?: (v: number) => number): Policy {
  let counter = 0;
  return {
    name,
    act(s, rng) {
      const { actions, forced } = candidateActions(s);
      if (forced) return actions[0];
      const cands = actions.map(newCandidate);
      evaluate(s, cands, 0, worlds, { seed: ((rng() * 2 ** 31) | 0) + counter++, ...opt });
      let best = cands[0];
      let bestV = -Infinity;
      for (const c of cands) {
        const m = valueFn ? mean(c.values.map(valueFn)) : mean(c.values);
        if (m > bestV) {
          bestV = m;
          best = c;
        }
      }
      return best.action;
    },
  };
}
