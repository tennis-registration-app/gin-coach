import { type Card, VALUE, cardName, rankOf, RANKS } from '../engine/cards';
import { type Action, HandState } from '../engine/hand';
import { deadwood, discardDeadwoods } from '../engine/melds';
import { DEAD, MINE, OPP, UNSEEN, cardStatus, liveOuts } from '../bots/policy';
import { type Models } from '../bots/learned';
import { NK, NV, kFeatures, makeCtx, vFeatures, type Ctx } from './features';
import { DEFAULT_WEIGHTS, holdWeights, sameAction } from './mc';
import { type Estimate } from './model';
import { gameWinChance } from './equity';

export type Category = 'pile' | 'high-cards' | 'feeding' | 'broke-combo' | 'knock-early' | 'knock-late' | 'other';

export const CATEGORY_LABEL: Record<Category, string> = {
  pile: 'Discard-pile decisions',
  'high-cards': 'Holding high cards too long',
  feeding: 'Feeding the opponent',
  'broke-combo': 'Breaking up combinations',
  'knock-early': 'Knocking too early',
  'knock-late': 'Knocking too late / chasing gin',
  other: 'Other discards',
};

export interface OptionEval {
  action: Action;
  label: string;
  /** expected points for this hand (positive is good for you) */
  ev: number;
  members: number[];
  pWin: number;
  pLose: number;
  ptsWin: number;
  ptsLose: number;
  /** estimated chance of winning the game (only when match context is supplied) */
  equity?: number;
  deadwoodAfter?: number;
  /** true when the value is a nominal figure rather than a model estimate (gin, big gin) */
  nominal?: boolean;
}

export interface MatchContext {
  us: number;
  them: number;
  /** partner's result this hand if already known: positive = our team scored */
  partnerDelta: number | null;
  target: number;
}

export interface Analysis {
  kind: 'draw' | 'discard';
  options: OptionEval[]; // best first (by points)
  forced: boolean;
  /** opening pass/take decisions are approximated */
  approximate: boolean;
  /** option preferred once the game score is considered (may equal options[0]) */
  matchBest?: OptionEval;
}

export interface Verdict {
  chosen: OptionEval;
  best: OptionEval;
  /** expected points given up versus the best option */
  loss: number;
  /** rough two-sigma margin of error on the loss */
  margin: number;
  flagged: boolean;
  tooClose: boolean;
  category: Category | null;
  headline: string;
  reasons: string[];
  /** game-win chance given up, in percentage points, when the score mattered */
  equityLoss?: number;
  usedMatchScore: boolean;
}

export const FLAG_THRESHOLD = 1.5;

export function actionLabel(a: Action, s?: HandState): string {
  switch (a.type) {
    case 'take':
      return s && s.topDiscard >= 0 ? `Take the ${cardName(s.topDiscard)}` : 'Take the pile card';
    case 'pass':
      return 'Pass';
    case 'stock':
      return 'Draw from the stock';
    case 'biggin':
      return 'Declare eleven-card gin';
    case 'discard':
      return a.knock ? `Knock, discarding ${cardName(a.card)}` : `Discard ${cardName(a.card)}`;
  }
}

const fv = new Float32Array(NV);
const fk = new Float32Array(NK);
const dws = new Int16Array(11);

function fromEstimate(action: Action, label: string, e: Estimate, deadwoodAfter?: number): OptionEval {
  return { action, label, ev: e.ev, members: e.members, pWin: e.pWin, pLose: e.pLose, ptsWin: e.ptsWin, ptsLose: e.ptsLose, deadwoodAfter };
}

function nominalOption(action: Action, label: string, points: number, k: number): OptionEval {
  return { action, label, ev: points, members: Array(k).fill(points), pWin: 1, pLose: 0, ptsWin: points, ptsLose: 0, deadwoodAfter: 0, nominal: true };
}

/** Evaluate every legal discard (and knock) for an 11-card hand. Best first. */
function discardOptions(hand: readonly Card[], justTaken: Card, ctx: Ctx, m: Models, rules: HandState['rules'], drawn: Card = -1, label = true): OptionEval[] {
  const k = m.v.nets.length;
  if (deadwood(hand) === 0) return [nominalOption({ type: 'biggin' }, 'Declare eleven-card gin', rules.bigGinBonus + 20, k)];
  discardDeadwoods(hand, dws);
  const local = Array.from(dws.subarray(0, hand.length));
  const out: OptionEval[] = [];
  let minDw = 999;
  for (let i = 0; i < hand.length; i++) if (hand[i] !== justTaken && local[i] < minDw) minDw = local[i];
  for (let i = 0; i < hand.length; i++) {
    const d = hand[i];
    if (d === justTaken) continue;
    const H = hand.filter((_, j) => j !== i);
    if (local[i] === 0) {
      out.push(nominalOption({ type: 'discard', card: d, knock: true }, label ? `Gin, discarding ${cardName(d)}` : '', rules.ginBonus + 20, k));
    }
    const a: Action = { type: 'discard', card: d, knock: false };
    if (local[i] === 0) {
      // Holding a gin hand and not declaring it: the model never saw this in training, so
      // rate it a fixed amount below taking the gin (waiting for eleven-card gin risks the hand).
      out.push({ ...nominalOption(a, label ? actionLabel(a) : '', rules.ginBonus + 20 - 6, k), pWin: 0.9, pLose: 0.1 });
      continue;
    }
    vFeatures(H, d, ctx, fv, drawn);
    out.push(fromEstimate(a, label ? actionLabel(a) : '', m.v.estimate(fv), local[i]));
    if (local[i] > 0 && local[i] <= ctx.limit && local[i] <= minDw + 2) {
      kFeatures(H, ctx, fk);
      const ka: Action = { type: 'discard', card: d, knock: true };
      out.push(fromEstimate(ka, label ? actionLabel(ka) : '', m.k.estimate(fk), local[i]));
    }
  }
  return out.sort((a, b) => b.ev - a.ev);
}

function average(parts: { w: number; o: OptionEval }[], action: Action, label: string): OptionEval {
  const k = parts[0].o.members.length;
  const acc: OptionEval = { action, label, ev: 0, members: Array(k).fill(0), pWin: 0, pLose: 0, ptsWin: 0, ptsLose: 0 };
  let tot = 0;
  for (const { w, o } of parts) {
    tot += w;
    acc.ev += w * o.ev;
    acc.pWin += w * o.pWin;
    acc.pLose += w * o.pLose;
    acc.ptsWin += w * o.ptsWin;
    acc.ptsLose += w * o.ptsLose;
    for (let i = 0; i < k; i++) acc.members[i] += w * o.members[i];
  }
  acc.ev /= tot;
  acc.pWin /= tot;
  acc.pLose /= tot;
  acc.ptsWin /= tot;
  acc.ptsLose /= tot;
  for (let i = 0; i < k; i++) acc.members[i] /= tot;
  return acc;
}

function equityOf(o: OptionEval, mc: MatchContext): number {
  const pu = mc.partnerDelta && mc.partnerDelta > 0 ? mc.partnerDelta : 0;
  const pt = mc.partnerDelta && mc.partnerDelta < 0 ? -mc.partnerDelta : 0;
  const us = mc.us + pu;
  const them = mc.them + pt;
  const pDraw = Math.max(0, 1 - o.pWin - o.pLose);
  const w = o.pWin > 0.001 ? o.ptsWin / o.pWin : 0;
  const l = o.pLose > 0.001 ? o.ptsLose / o.pLose : 0;
  return o.pWin * gameWinChance(us + w, them, mc.target) + o.pLose * gameWinChance(us, them + l, mc.target) + pDraw * gameWinChance(us, them, mc.target);
}

/** Analyse the decision facing the player to move, using only what that player can see. */
export function analyze(s: HandState, m: Models, mc?: MatchContext): Analysis {
  const p = s.turn;
  const hand = s.hands[p];
  const st = cardStatus(s, p);
  const ctx = makeCtx(s, p, st, holdWeights(s, p, DEFAULT_WEIGHTS));
  let options: OptionEval[];
  let kind: 'draw' | 'discard';
  let approximate = false;
  if (s.phase === 'draw') {
    kind = 'draw';
    const decline: Action = s.opening <= 1 ? { type: 'pass' } : { type: 'stock' };
    approximate = s.opening <= 1;
    const parts: { w: number; o: OptionEval }[] = [];
    const h11 = hand.slice();
    h11.push(0);
    for (const c of ctx.unseen) {
      const w = 1 - ctx.q[c];
      if (w <= 0) continue;
      h11[hand.length] = c;
      parts.push({ w, o: discardOptions(h11, -1, ctx, m, s.rules, c, false)[0] });
    }
    const stock = average(parts, decline, actionLabel(decline, s));
    options = [stock];
    if (s.opening !== 2 && s.topDiscard >= 0) {
      const top = s.topDiscard;
      const ctxT: Ctx = { ...ctx, myKnown: ctx.myKnown + 1 };
      const bestAfter = discardOptions([...hand, top], top, ctxT, m, s.rules, -1, false)[0];
      options.push({ ...bestAfter, action: { type: 'take' }, label: actionLabel({ type: 'take' }, s), deadwoodAfter: bestAfter.deadwoodAfter });
    }
    options.sort((a, b) => b.ev - a.ev);
  } else {
    kind = 'discard';
    options = discardOptions(hand, s.justTaken, ctx, m, s.rules);
  }
  const res: Analysis = { kind, options, forced: options.length === 1, approximate };
  if (mc) {
    for (const o of options) o.equity = equityOf(o, mc);
    res.matchBest = options.reduce((a, b) => (b.equity! > a.equity! ? b : a));
  }
  return res;
}

function diffStats(a: OptionEval, b: OptionEval): { diff: number; margin: number } {
  const k = Math.min(a.members.length, b.members.length);
  const diff = a.ev - b.ev;
  if (a.nominal || b.nominal || k < 2) return { diff, margin: 1 };
  let ss = 0;
  for (let i = 0; i < k; i++) {
    const d = a.members[i] - b.members[i] - diff;
    ss += d * d;
  }
  const sd = Math.sqrt(ss / (k - 1));
  // two-sigma on the ensemble disagreement, with a floor for model error shared by all members
  return { diff, margin: Math.sqrt(4 * sd * sd + 0.25) };
}

const pct = (x: number) => `${Math.round(100 * x)}%`;
const pts = (x: number) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(1);
const list = (cs: Card[]) => cs.map(cardName).join(', ');

interface CardFacts {
  outs: Card[];
  partnersInHand: Card[];
  oppRelated: Card[];
  deadPartners: number;
  oppThrewSameRank: boolean;
  inMeld: boolean;
}

function cardFacts(s: HandState, p: number, c: Card, st: Uint8Array): CardFacts {
  const outs: Card[] = [];
  liveOuts(c, st, outs);
  const r = c % 13;
  const b = c - r;
  const partners: Card[] = [];
  const oppRelated: Card[] = [];
  let deadPartners = 0;
  for (let s2 = 0; s2 < 4; s2++) {
    const o = s2 * 13 + r;
    if (o === c) continue;
    if (st[o] === MINE) partners.push(o);
    if (st[o] === OPP) oppRelated.push(o);
    if (st[o] === DEAD) deadPartners++;
  }
  for (const dr of [-2, -1, 1, 2]) {
    const rr = r + dr;
    if (rr < 0 || rr > 12) continue;
    const o = b + rr;
    if (Math.abs(dr) === 1 && st[o] === MINE) partners.push(o);
    if (st[o] === OPP) oppRelated.push(o);
  }
  const hand = s.hands[p];
  const inMeld = deadwood(hand.filter((x) => x !== c)) > deadwood(hand) - VALUE[c];
  const oppThrewSameRank = s.discards[1 - p].some((x) => rankOf(x) === r);
  return { outs: [...new Set(outs)], partnersInHand: partners, oppRelated, deadPartners, oppThrewSameRank, inMeld };
}

function dangerNote(c: Card, f: CardFacts): string | null {
  if (f.oppRelated.length) return `Your opponent picked up the ${list(f.oppRelated)}, so the ${cardName(c)} may be exactly what they need.`;
  return null;
}

function safetyNote(c: Card, f: CardFacts): string | null {
  if (f.deadPartners >= 2) return `The ${cardName(c)} is a safe throw for sets: ${f.deadPartners} of the other ${RANKS[c % 13]}s are already in the pile.`;
  if (f.oppThrewSameRank) return `Your opponent has thrown a ${RANKS[c % 13]} already, so they are unlikely to want the ${cardName(c)}.`;
  return null;
}

/** Compare the player's action with the analysis and explain. */
export function judge(s: HandState, an: Analysis, userAction: Action, useMatch = true): Verdict {
  const p = s.turn;
  let chosen = an.options.find((o) => sameAction(o.action, userAction));
  if (!chosen) {
    // e.g. a knock with a non-minimal discard that was not enumerated: fall back to nearest option
    chosen = an.options.find((o) => o.action.type === userAction.type && (o.action as { card?: Card }).card === (userAction as { card?: Card }).card) ?? an.options[an.options.length - 1];
  }
  let best = an.options[0];
  let usedMatchScore = false;
  let equityLoss: number | undefined;
  if (useMatch && an.matchBest && chosen.equity !== undefined) {
    const eqGap = an.matchBest.equity! - best.equity!;
    if (an.matchBest !== best && eqGap > 0.01) {
      best = an.matchBest;
      usedMatchScore = true;
    }
    equityLoss = Math.max(0, 100 * (best.equity! - chosen.equity));
  }
  const { diff, margin } = diffStats(best, chosen);
  const loss = Math.max(0, diff);
  // draw decisions are held to a higher bar: in testing, the one-draw lookahead did not
  // measurably beat the plain rule (take the pile card only when it melds)
  const threshold = an.kind === 'draw' ? FLAG_THRESHOLD * 2 : FLAG_THRESHOLD;
  const same = chosen === best;
  let flagged = !same && loss >= threshold && loss > margin;
  if (usedMatchScore && !same && (equityLoss ?? 0) >= 1.5) flagged = true;
  const tooClose = !same && !flagged && loss > 0.3;
  const v: Verdict = { chosen, best, loss: same ? 0 : loss, margin, flagged, tooClose, category: null, headline: '', reasons: [], equityLoss, usedMatchScore };
  if (same) {
    v.headline = 'Good move. The coach agrees.';
    return v;
  }
  if (!flagged) {
    v.headline = tooClose
      ? `Close call. The coach slightly prefers "${best.label}" (about ${loss.toFixed(1)} points, within the margin of error of ±${margin.toFixed(1)}).`
      : `Fine. "${best.label}" rates about the same.`;
    return v;
  }
  v.headline = `Mistake: about ${loss.toFixed(1)} points (±${margin.toFixed(1)}). Better: ${best.label}.`;
  const st = cardStatus(s, p).slice();
  const R = v.reasons;
  if (an.kind === 'draw') {
    v.category = 'pile';
    const top = s.topDiscard;
    const hand = s.hands[p];
    const d0 = deadwood(hand);
    const d11 = deadwood([...hand, top]);
    const melds = d11 < d0 + VALUE[top];
    if (userAction.type === 'take') {
      if (!melds) R.push(`The ${cardName(top)} does not complete a meld. Taking it tells your opponent what you are collecting and gives up a fresh card from the stock.`);
      else R.push(`The ${cardName(top)} does join a meld, but the coach rates a stock draw higher here: your hand has enough live cards in the stock, and taking shows your opponent your holding.`);
      R.push(`Expected result: ${pts(chosen.ev)} taking it versus ${pts(best.ev)} drawing from the stock.`);
    } else {
      if (melds) {
        const after = best.deadwoodAfter;
        R.push(`The ${cardName(top)} completes a meld${after !== undefined ? ` and brings your deadwood down to ${after}` : ''}${after !== undefined && after <= s.knockLimit ? `, enough to knock at this limit of ${s.knockLimit}` : ''}.`);
      } else {
        R.push(`The ${cardName(top)} does not meld, but it lowers your deadwood enough to matter here${best.deadwoodAfter !== undefined && best.deadwoodAfter <= s.knockLimit ? ` (you could knock with ${best.deadwoodAfter})` : ''}.`);
      }
      R.push(`Expected result: ${pts(chosen.ev)} for your play versus ${pts(best.ev)} taking it.`);
    }
    if (an.approximate) R.push('Opening pass-or-take decisions are estimated more roughly than other moves.');
  } else {
    const bestKnock = best.action.type === 'biggin' || (best.action.type === 'discard' && best.action.knock);
    const userKnock = userAction.type === 'biggin' || (userAction.type === 'discard' && userAction.knock);
    const uc = userAction.type === 'discard' ? userAction.card : -1;
    const bc = best.action.type === 'discard' ? best.action.card : -1;
    if (bestKnock && !userKnock) {
      v.category = 'knock-late';
      if (best.nominal) R.push('You had gin available. Gin scores 25 plus your opponent\'s deadwood and cannot be undercut.');
      else {
        R.push(`Knocking with ${best.deadwoodAfter} wins about ${pct(best.pWin)} of the time here for an average of ${pts(best.ev)}. Playing on is worth about ${pts(chosen.ev)}.`);
        R.push(`At your table an undercut costs only 10 plus the difference, so a knock this early is cheap insurance against your opponent improving or going gin (about ${pct(chosen.pLose)} of hands if you wait).`);
      }
    } else if (userKnock && !bestKnock) {
      v.category = 'knock-early';
      R.push(`Knocking with ${chosen.deadwoodAfter} is worth about ${pts(chosen.ev)} (undercut risk about ${pct(chosen.pLose)}). Playing on by discarding the ${cardName(bc)} is worth about ${pts(best.ev)}.`);
      R.push(`Gin pays 25 plus deadwood here against a small gain for the knock, and your hand has good chances to improve before your opponent is ready.`);
    } else if (uc >= 0 && bc >= 0) {
      const fu = cardFacts(s, p, uc, st);
      const fb = cardFacts(s, p, bc, st);
      const dwGap = (chosen.deadwoodAfter ?? 0) - (best.deadwoodAfter ?? 0);
      const du = dangerNote(uc, fu);
      if (userKnock && bestKnock) {
        v.category = 'other';
        R.push(`Both plays knock, but discarding the ${cardName(bc)} leaves you ${best.deadwoodAfter} deadwood instead of ${chosen.deadwoodAfter}.`);
      } else if (fu.inMeld || dwGap >= 6) {
        v.category = fu.inMeld ? 'broke-combo' : 'high-cards';
        if (fu.inMeld) R.push(`The ${cardName(uc)} was part of a meld. Throwing it leaves ${chosen.deadwoodAfter} deadwood instead of ${best.deadwoodAfter}.`);
        else R.push(`Discarding the ${cardName(bc)} leaves ${best.deadwoodAfter} deadwood; your play leaves ${chosen.deadwoodAfter}. The ${cardName(bc)} is ${VALUE[bc]} points you are still carrying${fb.outs.length ? '' : ' with no live card that melds it'}.`);
      } else if (du && !fb.oppRelated.length) {
        v.category = 'feeding';
        R.push(du);
        const sb = safetyNote(bc, fb);
        if (sb) R.push(sb);
      } else if (fu.outs.length > fb.outs.length) {
        v.category = 'broke-combo';
        R.push(`The ${cardName(uc)} was working with ${list(fu.partnersInHand)}: ${fu.outs.length} live card${fu.outs.length === 1 ? '' : 's'} (${list(fu.outs)}) would have completed a meld.`);
        R.push(fb.outs.length ? `The ${cardName(bc)} has fewer ways to improve (${list(fb.outs)}).` : `The ${cardName(bc)} has no live card that would meld it.`);
      } else if (VALUE[bc] - VALUE[uc] >= 3) {
        v.category = 'high-cards';
        R.push(`The ${cardName(bc)} costs you ${VALUE[bc]} points if your opponent knocks; the ${cardName(uc)} costs ${VALUE[uc]}. Their chances of improving your hand are similar${fb.outs.length ? '' : ` (the ${cardName(bc)} has no live card that melds it)`}.`);
      } else {
        v.category = du ? 'feeding' : 'other';
        if (du) R.push(du);
        const sb = safetyNote(bc, fb);
        if (sb) R.push(sb);
        if (fb.outs.length < fu.outs.length || !R.length) R.push(`The ${cardName(bc)} does less for your hand than the ${cardName(uc)}: ${fb.outs.length} live melding card${fb.outs.length === 1 ? '' : 's'} versus ${fu.outs.length}.`);
      }
      R.push(`Expected result: ${pts(chosen.ev)} for your discard versus ${pts(best.ev)} for the ${cardName(bc)}.`);
    } else {
      v.category = 'other';
    }
  }
  if (usedMatchScore && equityLoss !== undefined) R.push(`The game score matters here: this choice changes your team's chance of winning the game by about ${equityLoss.toFixed(1)} percentage points.`);
  return v;
}

export { UNSEEN };
