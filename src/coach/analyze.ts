import { type Card, VALUE, cardName } from '../engine/cards';
import { type Action, HandState } from '../engine/hand';
import { deadwood, discardDeadwoods } from '../engine/melds';
import { UNSEEN, cardStatus } from '../bots/policy';
import { compareDiscards, knockCheck, realOuts, type WhySection } from './facts';
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
  /** the four checks (or the equivalent for draws and knocks) behind the verdict */
  why: { title: string; lines: string[] }[];
  /** the play the checks compare yours against */
  versus: string;
  /** near-equal alternatives to the best play (within the margin of error) */
  ties: string[];
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
const cardList = (cs: Card[]) => cs.map(cardName).join(', ');

const isKnock = (a: Action) => a.type === 'biggin' || (a.type === 'discard' && a.knock);

/** Plays that rate within the margin of error of the best one (best first). */
export function nearTies(an: Analysis): OptionEval[] {
  const best = an.options[0];
  return an.options.filter((o) => {
    if (o === best) return true;
    const { diff, margin } = diffStats(best, o);
    return diff < Math.max(1, margin);
  });
}

function knockSections(s: HandState, st: Uint8Array, knock: OptionEval, wait: OptionEval): { title: string; lines: string[] }[] {
  const hand = s.hands[s.turn];
  const out: { title: string; lines: string[] }[] = [];
  if (knock.nominal) {
    out.push({ title: 'Going gin', lines: [`Gin scores ${s.rules.ginBonus} plus your opponent's deadwood and cannot be undercut.`] });
  } else {
    out.push({
      title: `Knocking with ${knock.deadwoodAfter}`,
      lines: [
        `You win the hand about ${pct(knock.pWin)} of the time and are undercut about ${pct(knock.pLose)}. Average result ${pts(knock.ev)}.`,
        `An undercut costs ${s.rules.undercutBonus} plus the difference.`,
      ],
    });
  }
  if (wait.action.type === 'discard') {
    const k = knockCheck(hand.filter((x) => x !== (wait.action as { card: Card }).card), st, s.knockLimit);
    out.push({
      title: `Playing on (discarding the ${cardName(wait.action.card)})`,
      lines: [
        `Average result ${pts(wait.ev)}. Your opponent scores in about ${pct(wait.pLose)} of hands from here.`,
        k.ginDraws.length ? `${k.ginDraws.length} live card${k.ginDraws.length === 1 ? '' : 's'} would give you gin next turn (${cardList(k.ginDraws.slice(0, 6))}), for ${s.rules.ginBonus} plus deadwood.` : 'No single card gives you gin next turn.',
        `${s.stock.length} cards remain in the stock.`,
      ],
    });
  }
  return out;
}

function drawSections(s: HandState, st: Uint8Array, take: OptionEval | undefined, stock: OptionEval): { title: string; lines: string[] }[] {
  const p = s.turn;
  const hand = s.hands[p];
  const top = s.topDiscard;
  const out: { title: string; lines: string[] }[] = [];
  if (take && top >= 0) {
    const d0 = deadwood(hand);
    const melds = deadwood([...hand, top]) < d0 + VALUE[top];
    const lines = [
      melds ? `The ${cardName(top)} completes a meld.` : `The ${cardName(top)} does not complete a meld.`,
      `Your deadwood would go from ${d0} to ${take.deadwoodAfter ?? '?'} after your discard${take.deadwoodAfter !== undefined && take.deadwoodAfter <= s.knockLimit ? ', enough to knock' : ''}.`,
      'Your opponent sees which card you took.',
      `Average result ${pts(take.ev)}.`,
    ];
    out.push({ title: `Taking the ${cardName(top)}`, lines });
  }
  let unseen = 0;
  let hits = 0;
  for (let x = 0; x < 52; x++) {
    if (st[x] !== UNSEEN) continue;
    unseen++;
    if (deadwood([...hand, x]) < deadwood(hand) + VALUE[x]) hits++;
  }
  out.push({
    title: stock.action.type === 'pass' ? 'Passing' : 'Drawing from the stock',
    lines: [`${hits} of the ${unseen} cards you have not seen would complete a meld.`, 'Your opponent learns nothing about your hand.', `Average result ${pts(stock.ev)}.`],
  });
  return out;
}

/** Compare the player's action with the analysis and explain. */
export function judge(s: HandState, an: Analysis, userAction: Action, useMatch = true): Verdict {
  const p = s.turn;
  let chosen = an.options.find((o) => sameAction(o.action, userAction));
  if (!chosen) {
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
  const ties = nearTies(an)
    .filter((o) => o !== chosen)
    .map((o) => o.label);
  const v: Verdict = { chosen, best, loss: same ? 0 : loss, margin, flagged, tooClose, category: null, headline: '', reasons: [], why: [], versus: '', ties, equityLoss, usedMatchScore };
  const st = cardStatus(s, p).slice();

  // the play to compare yours against: the coach's best, or the runner-up when you found the best
  const other = same ? an.options.find((o) => o !== chosen) : best;
  let sections: WhySection[] = [];
  if (other) {
    v.versus = other.label;
    if (an.kind === 'draw') {
      const take = [chosen, other].find((o) => o.action.type === 'take');
      const stock = [chosen, other].find((o) => o.action.type !== 'take')!;
      v.why = drawSections(s, st, take, stock);
    } else if (isKnock(chosen.action) !== isKnock(other.action)) {
      const knock = isKnock(chosen.action) ? chosen : other;
      const wait = isKnock(chosen.action) ? other : chosen;
      v.why = knockSections(s, st, knock, wait);
    } else if (chosen.action.type === 'discard' && other.action.type === 'discard' && chosen.action.card !== other.action.card) {
      sections = compareDiscards(s, p, st, chosen.action.card, other.action.card);
      v.why = sections.map(({ title, lines }) => ({ title, lines }));
    }
  }

  if (same) {
    v.headline = ties.length ? `Good move. The coach rates ${ties.slice(0, 3).join(', ')} about the same.` : 'Good move. The coach agrees.';
    return v;
  }
  if (!flagged) {
    v.headline = tooClose
      ? `Close call. The coach slightly prefers "${best.label}" (about ${loss.toFixed(1)} points, within the margin of error of ±${margin.toFixed(1)}).`
      : `Fine. "${best.label}" rates about the same.`;
    return v;
  }
  v.headline = `Mistake: about ${loss.toFixed(1)} points (±${margin.toFixed(1)}). Better: ${best.label}.`;
  const R = v.reasons;
  if (an.kind === 'draw') {
    v.category = 'pile';
    const top = s.topDiscard;
    const hand = s.hands[p];
    const melds = deadwood([...hand, top]) < deadwood(hand) + VALUE[top];
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
    const bestKnock = isKnock(best.action);
    const userKnock = isKnock(userAction);
    const uc = userAction.type === 'discard' ? userAction.card : -1;
    const bc = best.action.type === 'discard' ? best.action.card : -1;
    if (bestKnock && !userKnock) {
      v.category = 'knock-late';
      if (best.nominal) R.push(`You had gin available. Gin scores ${s.rules.ginBonus} plus your opponent's deadwood and cannot be undercut.`);
      else {
        R.push(`Knocking with ${best.deadwoodAfter} wins about ${pct(best.pWin)} of the time here for an average of ${pts(best.ev)}. Playing on is worth about ${pts(chosen.ev)}.`);
        R.push(`An undercut would cost you ${s.rules.undercutBonus} plus the difference, but waiting gives your opponent time to improve or go gin (they score in about ${pct(chosen.pLose)} of hands if you play on).`);
      }
    } else if (userKnock && !bestKnock) {
      v.category = 'knock-early';
      R.push(`Knocking with ${chosen.deadwoodAfter} is worth about ${pts(chosen.ev)} (undercut risk about ${pct(chosen.pLose)}). Playing on by discarding the ${cardName(bc)} is worth about ${pts(best.ev)}.`);
      R.push(`Gin pays ${s.rules.ginBonus} plus deadwood against a small gain for the knock, an undercut costs ${s.rules.undercutBonus} plus the difference, and your hand has good chances to improve before your opponent is ready.`);
    } else if (userKnock && bestKnock) {
      v.category = 'other';
      R.push(`Both plays knock, but discarding the ${cardName(bc)} leaves you ${best.deadwoodAfter} deadwood instead of ${chosen.deadwoodAfter}.`);
    } else if (uc >= 0 && bc >= 0 && sections.length) {
      // the checks that favour the coach's play, biggest difference first (sections compare yours, then the coach's)
      const against = sections.filter((x) => x.favours === -1 && x.weight > 0);
      const lead = against[0] ?? sections[0];
      v.category = lead.title.startsWith('How safe') ? 'feeding' : lead.title.startsWith('What could') ? 'broke-combo' : 'high-cards';
      for (const sec of against.slice(0, 2)) for (const line of sec.lines) R.push(line);
      if (!against.length) R.push(`The four checks are close; the difference comes from how the coach's model weighs them together.`);
      R.push(`Expected result: ${pts(chosen.ev)} for your discard versus ${pts(best.ev)} for the ${cardName(bc)}.`);
    } else {
      v.category = 'other';
    }
  }
  if (usedMatchScore && equityLoss !== undefined) R.push(`The game score matters here: this choice changes your team's chance of winning the game by about ${equityLoss.toFixed(1)} percentage points.`);
  return v;
}

export { UNSEEN, realOuts };
