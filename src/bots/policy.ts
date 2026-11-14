import { type Card, type Rng, VALUE } from '../engine/cards';
import { type Action, HandState } from '../engine/hand';
import { deadwood, discardDeadwoods } from '../engine/melds';

/**
 * A policy chooses an action for the player to move. Policies must use only what that
 * player can legitimately see: own hand, the discard pile, the knock limit, stock size,
 * cards the opponent picked up from the pile, and the history of discards and passes.
 */
export interface Policy {
  name: string;
  act(s: HandState, rng: Rng): Action;
}

const dws = new Int16Array(11);

// ---------------------------------------------------------------------------------------------
// Baseline: port of the published policy of the EAAI-2021 challenge's SimpleGinRummyPlayer.
// Takes the face-up card only if it joins a meld, discards to leave the least deadwood
// (random among ties), and knocks as soon as it legally can.
// ---------------------------------------------------------------------------------------------
export const simplePolicy: Policy = {
  name: 'Baseline (EAAI simple)',
  act(s, rng) {
    const hand = s.hands[s.turn];
    if (s.phase === 'draw') {
      if (s.opening === 2) return { type: 'stock' };
      const top = s.topDiscard;
      const melds = top >= 0 && deadwood([...hand, top]) < deadwood(hand) + VALUE[top];
      if (melds) return { type: 'take' };
      return s.opening <= 1 ? { type: 'pass' } : { type: 'stock' };
    }
    if (deadwood(hand) === 0) return { type: 'biggin' };
    discardDeadwoods(hand, dws);
    let best = 999;
    const ties: Card[] = [];
    for (let i = 0; i < hand.length; i++) {
      if (hand[i] === s.justTaken) continue;
      if (dws[i] < best) {
        best = dws[i];
        ties.length = 0;
      }
      if (dws[i] === best) ties.push(hand[i]);
    }
    const card = ties[(rng() * ties.length) | 0];
    return { type: 'discard', card, knock: best <= s.knockLimit };
  },
};

// ---------------------------------------------------------------------------------------------
// Heuristic policy: deadwood, live outs for combinations, discard safety, knock timing.
// ---------------------------------------------------------------------------------------------
export interface HeuristicParams {
  /** Points a live out is worth when deciding what to keep (early in the hand). */
  wConn: number;
  /** How much wConn shrinks as the stock runs down (0 = constant). */
  connDecay: number;
  /** Points per unit of discard danger. */
  wDanger: number;
  /** Points per unseen card that would pair up or sit next to a lone card. */
  wSingle: number;
  /** Take a non-melding pile card if it lets us knock at once. */
  takeToKnock: boolean;
  /** After this many total discards, only knock when deadwood is at most lateKnockMax. */
  lateTurn: number;
  lateKnockMax: number;
  /** Hold out for gin instead of knocking when at least this many live gin outs and stock is deep. */
  ginOuts: number;
  ginMinStock: number;
}

export const DEFAULT_PARAMS: HeuristicParams = {
  wConn: 2.2,
  connDecay: 0.7,
  wDanger: 3,
  wSingle: 0.1,
  takeToKnock: true,
  lateTurn: 16,
  lateKnockMax: 7,
  ginOuts: 99,
  ginMinStock: 99,
};

// status of each card from the mover's point of view
export const UNSEEN = 0;
export const MINE = 1;
export const DEAD = 2; // in the discard pile
export const OPP = 3; // known to be in the opponent's hand
const status = new Uint8Array(52);

/** Fill and return the shared status table for player p. */
export function cardStatus(s: HandState, p: number): Uint8Array {
  status.fill(UNSEEN);
  const d = s.discard;
  for (let i = 0; i < d.length; i++) status[d[i]] = DEAD;
  const k = s.known[1 - p];
  for (let c = 0; c < 52; c++) if (k[c]) status[c] = OPP;
  const h = s.hands[p];
  for (let i = 0; i < h.length; i++) status[h[i]] = MINE;
  return status;
}

/** Unseen cards that would complete a three-card meld with `c` and one other card in hand. */
export function liveOuts(c: Card, st: Uint8Array, out?: Card[]): number {
  const r = c % 13;
  const base = c - r;
  let n = 0;
  let pair = false;
  for (let s2 = 0; s2 < 4; s2++) {
    const o = s2 * 13 + r;
    if (o !== c && st[o] === MINE) pair = true;
  }
  if (pair) {
    for (let s2 = 0; s2 < 4; s2++) {
      const o = s2 * 13 + r;
      if (st[o] === UNSEEN) {
        n++;
        out?.push(o);
      }
    }
  }
  const has = (rr: number) => rr >= 0 && rr < 13 && st[base + rr] === MINE;
  const live = (rr: number) => rr >= 0 && rr < 13 && st[base + rr] === UNSEEN;
  const add = (rr: number) => {
    n++;
    out?.push(base + rr);
  };
  if (live(r - 1) && (has(r + 1) || has(r - 2))) add(r - 1);
  if (live(r + 1) && (has(r - 1) || has(r + 2))) add(r + 1);
  if (live(r - 2) && has(r - 1)) add(r - 2);
  if (live(r + 2) && has(r + 1)) add(r + 2);
  return n;
}

/**
 * Danger of discarding c: expected number of two-card holdings in the opponent's hand that
 * would meld with it. Known opponent cards count fully, dead cards not at all, and unseen
 * cards by the chance the opponent holds them.
 */
export function danger(c: Card, st: Uint8Array, pUnseen: number): number {
  const r = c % 13;
  const base = c - r;
  const pr = (card: number) => {
    const t = st[card];
    return t === OPP ? 1 : t === UNSEEN ? pUnseen : 0;
  };
  // sets
  let a = 0;
  let b = 0;
  let cc = 0;
  let k = 0;
  for (let s2 = 0; s2 < 4; s2++) {
    const o = s2 * 13 + r;
    if (o === c) continue;
    const p = pr(o);
    if (k === 0) a = p;
    else if (k === 1) b = p;
    else cc = p;
    k++;
  }
  let d = a * b + a * cc + b * cc;
  const q = (rr: number) => (rr >= 0 && rr < 13 ? pr(base + rr) : 0);
  d += q(r - 2) * q(r - 1) + q(r - 1) * q(r + 1) + q(r + 1) * q(r + 2);
  return d;
}

/** Chance that any given unseen card is in the opponent's hand (before inference). */
export function oppHoldChance(s: HandState, p: number, st: Uint8Array): number {
  let unseen = 0;
  let oppKnown = 0;
  for (let c = 0; c < 52; c++) {
    if (st[c] === UNSEEN) unseen++;
    else if (st[c] === OPP) oppKnown++;
  }
  return unseen > 0 ? Math.min(1, (s.hands[1 - p].length - oppKnown) / unseen) : 0;
}

export interface DiscardOption {
  card: Card;
  deadwoodAfter: number;
  score: number;
  outs: number;
  danger: number;
}

/** Every legal discard for the player to move, scored by the heuristic (best first). */
export function scoreDiscards(s: HandState, P: HeuristicParams = DEFAULT_PARAMS): DiscardOption[] {
  const p = s.turn;
  const hand = s.hands[p];
  const st = cardStatus(s, p);
  const pUnseen = oppHoldChance(s, p, st);
  const stage = Math.max(0, Math.min(1, s.stock.length / 31));
  const wConn = P.wConn * (1 - P.connDecay * (1 - stage));
  const local = new Int16Array(11);
  discardDeadwoods(hand, local);
  const out: DiscardOption[] = [];
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i];
    if (c === s.justTaken) continue;
    const outs = liveOuts(c, st);
    const dg = danger(c, st, pUnseen);
    out.push({ card: c, deadwoodAfter: local[i], outs, danger: dg, score: local[i] + wConn * outs + P.wDanger * dg + P.wSingle * stage * neighbours(c, st) });
  }
  return out.sort((a, b) => a.score - b.score);
}

/** Unseen cards of the same rank or adjacent in suit: how easily a card can start a combination. */
export function neighbours(c: Card, st: Uint8Array): number {
  const r = c % 13;
  const base = c - r;
  let n = 0;
  for (let s2 = 0; s2 < 4; s2++) if (s2 * 13 + r !== c && st[s2 * 13 + r] === UNSEEN) n++;
  if (r > 0 && st[base + r - 1] === UNSEEN) n++;
  if (r < 12 && st[base + r + 1] === UNSEEN) n++;
  return n;
}

export function makeHeuristic(params: HeuristicParams = DEFAULT_PARAMS, name = 'Heuristic'): Policy {
  const P = params;
  return {
    name,
    act(s) {
      const p = s.turn;
      const hand = s.hands[p];
      if (s.phase === 'draw') {
        if (s.opening === 2) return { type: 'stock' };
        const top = s.topDiscard;
        const decline: Action = s.opening <= 1 ? { type: 'pass' } : { type: 'stock' };
        if (top < 0) return decline;
        const d0 = deadwood(hand);
        hand.push(top);
        const d11 = deadwood(hand);
        let take = d11 < d0 + VALUE[top];
        if (!take && P.takeToKnock && d0 > s.knockLimit) {
          discardDeadwoods(hand, dws);
          let best = 999;
          for (let i = 0; i < hand.length - 1; i++) if (dws[i] < best) best = dws[i];
          if (best <= s.knockLimit && best <= P.lateKnockMax) take = true;
        }
        hand.pop();
        return take ? { type: 'take' } : decline;
      }
      // discard phase
      discardDeadwoods(hand, dws);
      let minDw = 999;
      let minCard = -1;
      for (let i = 0; i < hand.length; i++) {
        if (hand[i] === s.justTaken) continue;
        if (dws[i] < minDw) {
          minDw = dws[i];
          minCard = hand[i];
        }
      }
      if (deadwood(hand) === 0) return { type: 'biggin' };
      if (minDw === 0) return { type: 'discard', card: minCard, knock: true };
      const st = cardStatus(s, p);
      if (minDw <= s.knockLimit) {
        const late = s.turnsTaken >= P.lateTurn;
        let knock = !late || minDw <= P.lateKnockMax;
        if (knock && P.ginOuts < 50 && s.stock.length >= P.ginMinStock) {
          // count live gin outs after the min-deadwood discard
          const rest = hand.filter((c) => c !== minCard);
          let outs = 0;
          for (let c = 0; c < 52; c++) {
            if (st[c] !== UNSEEN) continue;
            rest.push(c);
            discardDeadwoods(rest, dws);
            for (let i = 0; i < rest.length; i++)
              if (dws[i] === 0) {
                outs++;
                break;
              }
            rest.pop();
          }
          discardDeadwoods(hand, dws);
          if (outs >= P.ginOuts) knock = false;
        }
        if (knock) return { type: 'discard', card: minCard, knock: true };
      }
      const pUnseen = oppHoldChance(s, p, st);
      const stage = Math.max(0, Math.min(1, s.stock.length / 31));
      const wConn = P.wConn * (1 - P.connDecay * (1 - stage));
      let bestScore = 1e9;
      let bestCard = -1;
      for (let i = 0; i < hand.length; i++) {
        const c = hand[i];
        if (c === s.justTaken) continue;
        const score = dws[i] + wConn * liveOuts(c, st) + P.wDanger * danger(c, st, pUnseen) + P.wSingle * stage * neighbours(c, st);
        if (score < bestScore - 1e-9) {
          bestScore = score;
          bestCard = c;
        }
      }
      return { type: 'discard', card: bestCard, knock: false };
    },
  };
}

export const heuristicPolicy = makeHeuristic();

/** Play a hand to completion. Returns the state (with result). */
export function playHand(s: HandState, policies: [Policy, Policy], rng: Rng): HandState {
  let guard = 0;
  while (s.phase !== 'over') {
    s.apply(policies[s.turn].act(s, rng));
    if (++guard > 400) throw new Error('hand did not terminate');
  }
  return s;
}
