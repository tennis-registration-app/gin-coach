import { type Card, VALUE, cardName } from '../engine/cards';
import { HandState } from '../engine/hand';
import { arrange, deadwood, discardDeadwoods } from '../engine/melds';
import { DEAD, MINE, OPP, UNSEEN } from '../bots/policy';
import { holdWeights } from './mc';

// The four checks behind every explanation. Everything here is computed from what the
// player can see, using the same meld search as the coach's numbers.

const list = (cs: readonly Card[]): string => {
  const n = cs.map(cardName);
  if (n.length <= 1) return n.join('');
  return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
};
const RANK_WORD = ['an ace', 'a 2', 'a 3', 'a 4', 'a 5', 'a 6', 'a 7', 'an 8', 'a 9', 'a 10', 'a jack', 'a queen', 'a king'];
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/** Unseen cards that would put `c` into a meld, given the ten cards held. */
export function realOuts(held: readonly Card[], c: Card, st: Uint8Array): Card[] {
  const without = held.filter((x) => x !== c);
  if (deadwood(held) < deadwood(without) + VALUE[c]) return []; // already melded
  const outs: Card[] = [];
  for (let x = 0; x < 52; x++) {
    if (st[x] !== UNSEEN) continue;
    if (deadwood([...held, x]) < deadwood([...without, x]) + VALUE[c]) outs.push(x);
  }
  return outs;
}

export interface ImproveCheck {
  /** live cards that would meld this card */
  outs: Card[];
  /** outs the opponent probably holds, with the pickup that suggests it */
  suspect: { card: Card; because: Card }[];
  /** cards that would have melded it but are gone */
  gone: { card: Card; where: 'pile' | 'opponent' }[];
  /** true if the card is already part of a meld */
  inMeld: boolean;
  /** a partner card in hand that is committed to, or also wanted by, another combination */
  shared: { partner: Card; locked: boolean; alsoWants: Card[] } | null;
  /** outs that would make a meld even without this card: keeping it only lets it join that meld */
  riding: { card: Card; meld: Card[] }[];
}

/** Check 1: what can still improve card `c` if you keep it (and throw `other` instead). */
export function improveCheck(s: HandState, p: number, hand: readonly Card[], c: Card, other: Card, st: Uint8Array): ImproveCheck {
  const held = hand.filter((x) => x !== other);
  const without = held.filter((x) => x !== c);
  const inMeld = deadwood(held) < deadwood(without) + VALUE[c];
  const outs = inMeld ? [] : realOuts(held, c, st);
  // what would meld it if every card not in your hand were still available
  const open = st.slice();
  for (let x = 0; x < 52; x++) if (open[x] !== MINE) open[x] = UNSEEN;
  const paper = inMeld ? [] : realOuts(held, c, open);
  const gone = paper.filter((x) => st[x] === DEAD || st[x] === OPP).map((x) => ({ card: x, where: st[x] === DEAD ? ('pile' as const) : ('opponent' as const) }));
  // outs made doubtful by an opponent pickup of a related card
  const suspect: { card: Card; because: Card }[] = [];
  const w = holdWeights(s, p);
  const known = s.known[1 - p];
  for (const x of outs) {
    if (w[x] < 1.25) continue;
    for (let k = 0; k < 52; k++) {
      if (!known[k]) continue;
      const sameRank = k % 13 === x % 13;
      const near = ((k / 13) | 0) === ((x / 13) | 0) && Math.abs((k % 13) - (x % 13)) <= 2;
      if (sameRank || near) {
        suspect.push({ card: x, because: k });
        break;
      }
    }
  }
  // a partner that is locked in a meld, or that other cards also want
  let shared: ImproveCheck['shared'] = null;
  const r = c % 13;
  const partners = held.filter((x) => x !== c && (x % 13 === r || (((x / 13) | 0) === ((c / 13) | 0) && Math.abs((x % 13) - r) <= 2)));
  for (const pt of partners) {
    const rest = without.filter((x) => x !== pt);
    const locked = deadwood(without) < deadwood(rest) + VALUE[pt];
    if (locked && outs.length === 0 && paper.length === 0) {
      shared = { partner: pt, locked: true, alsoWants: [] };
      break;
    }
    if (!locked && outs.length > 0) {
      const also = realOuts(without, pt, st).filter((x) => !outs.includes(x));
      if (also.length) {
        shared = { partner: pt, locked: false, alsoWants: also };
        break;
      }
    }
  }
  // outs that would complete a meld from your other cards anyway
  const riding: { card: Card; meld: Card[] }[] = [];
  for (const x of outs) {
    if (deadwood([...without, x]) < deadwood(without) + VALUE[x]) {
      const a = arrange([...without, x]);
      riding.push({ card: x, meld: a.melds.find((mm) => mm.includes(x)) ?? [] });
    }
  }
  if (riding.length) shared = null; // the riding note says it more precisely
  return { outs, suspect, gone, inMeld, shared, riding };
}

export interface SafetyCheck {
  /** two-card holdings that would meld with the discard and are not ruled out */
  usable: Card[][];
  /** of those, holdings that include a card the opponent is known to hold */
  withKnown: Card[][];
  oppThrewSameRank: boolean;
  /** 0 = provably unusable; higher = more dangerous */
  score: number;
}

/** Check 2: could the opponent use `c` in a meld, given the visible cards? `mine` is your hand after the discard. */
export function safetyCheck(s: HandState, p: number, c: Card, st: Uint8Array): SafetyCheck {
  const r = c % 13;
  const base = c - r;
  const combos: Card[][] = [];
  const others: Card[] = [];
  for (let s2 = 0; s2 < 4; s2++) if (s2 * 13 + r !== c) others.push(s2 * 13 + r);
  combos.push([others[0], others[1]], [others[0], others[2]], [others[1], others[2]]);
  if (r >= 2) combos.push([base + r - 2, base + r - 1]);
  if (r >= 1 && r <= 11) combos.push([base + r - 1, base + r + 1]);
  if (r <= 10) combos.push([base + r + 1, base + r + 2]);
  const free = (x: Card) => st[x] === UNSEEN || st[x] === OPP;
  const usable = combos.filter(([a, b]) => free(a) && free(b));
  const withKnown = usable.filter(([a, b]) => st[a] === OPP || st[b] === OPP);
  const oppThrewSameRank = s.discards[1 - p].some((x) => x % 13 === r);
  let score = 0;
  for (const [a, b] of usable) {
    const k = (st[a] === OPP ? 1 : 0) + (st[b] === OPP ? 1 : 0);
    score += k === 2 ? 6 : k === 1 ? 2.5 : 0.5;
  }
  if (oppThrewSameRank) score *= 0.8;
  return { usable, withKnown, oppThrewSameRank, score };
}

export interface KnockCheck {
  deadwoodAfter: number;
  /** unseen cards that would let you knock next turn (includes the gin cards) */
  knockDraws: Card[];
  ginDraws: Card[];
}

const tmp = new Int16Array(11);

/** Check 4: after discarding down to `held`, which draws would let you knock or gin next turn? */
export function knockCheck(held: readonly Card[], st: Uint8Array, limit: number): KnockCheck {
  const knockDraws: Card[] = [];
  const ginDraws: Card[] = [];
  const h = held.slice();
  h.push(0);
  for (let x = 0; x < 52; x++) {
    if (st[x] !== UNSEEN) continue;
    h[held.length] = x;
    discardDeadwoods(h, tmp);
    let m = 999;
    for (let i = 0; i < h.length; i++) if (tmp[i] < m) m = tmp[i];
    if (m === 0) ginDraws.push(x);
    if (m <= limit) knockDraws.push(x);
  }
  return { deadwoodAfter: deadwood(held), knockDraws, ginDraws };
}

export interface WhySection {
  title: string;
  lines: string[];
  /** how much this check separates the two plays (for ordering) */
  weight: number;
  /** which play this check favours: 1 = the first card named, -1 = the second, 0 = neither */
  favours: number;
}

function improveLine(c: Card, f: ImproveCheck): string {
  const name = cardName(c);
  if (f.inMeld) return `The ${name} is part of a meld, so throwing it breaks the meld up.`;
  let t: string;
  if (f.outs.length === 0) t = `The ${name} has no live card that would meld it.`;
  else t = `The ${name} has ${plural(f.outs.length, 'live card')} that would meld it: ${list(f.outs)}.`;
  if (f.suspect.length) {
    const by = [...new Set(f.suspect.map((x) => x.because))];
    t += ` ${f.suspect.length === 1 ? `The ${cardName(f.suspect[0].card)} is doubtful` : `${list(f.suspect.map((x) => x.card))} are doubtful`}: your opponent picked up the ${list(by)}.`;
  }
  const pile = f.gone.filter((g) => g.where === 'pile').map((g) => g.card);
  const opp = f.gone.filter((g) => g.where === 'opponent').map((g) => g.card);
  if (pile.length) t += ` Already in the pile: ${list(pile)}.`;
  if (opp.length) t += ` In your opponent's hand: ${list(opp)}.`;
  for (const r of f.riding) {
    t += ` The ${cardName(r.card)} would make ${list(r.meld)} even without the ${name}; keeping the ${name} only lets it join that meld (saving its ${VALUE[c]} points) if the ${cardName(r.card)} arrives.`;
  }
  if (f.shared?.locked) t += ` Its partner, the ${cardName(f.shared.partner)}, is already committed to a better meld.`;
  else if (f.shared) t += ` Its partner, the ${cardName(f.shared.partner)}, also works with other cards (${list(f.shared.alsoWants)}), so only one of those chances can pay off.`;
  return t;
}

function safetyLine(c: Card, f: SafetyCheck): string {
  const name = cardName(c);
  if (f.usable.length === 0) return `The ${name} is a provably safe throw: every meld it could join needs a card that is in the pile or in your own hand.`;
  let t: string;
  if (f.withKnown.length) {
    const ex = f.withKnown[0];
    t = `The ${name} is risky: your opponent is known to hold a card that works with it (it would meld with the ${list(ex)}).`;
  } else {
    const ex = f.usable.slice(0, 2).map((m) => list(m)).join('; or the ');
    t = `The ${name} is not safe: your opponent could use it ${f.usable.length === 1 ? 'one way' : `${f.usable.length} ways`} (for example with the ${ex}).`;
  }
  if (f.oppThrewSameRank) t += ` They have already thrown ${RANK_WORD[c % 13]}, which makes a set less likely.`;
  return t;
}

function knockLine(c: Card, k: KnockCheck, limit: number): string {
  const name = cardName(c);
  let t = `After throwing the ${name} you hold ${k.deadwoodAfter} deadwood.`;
  if (limit === 0) {
    t += k.ginDraws.length ? ` ${plural(k.ginDraws.length, 'card')} would give you gin next turn (${list(k.ginDraws.slice(0, 6))}).` : ' No single card gives you gin next turn.';
    return t;
  }
  if (k.knockDraws.length === 0) t += ' No single draw would let you knock next turn.';
  else {
    t += ` ${plural(k.knockDraws.length, 'card')} would let you knock next turn (${list(k.knockDraws.slice(0, 6))}${k.knockDraws.length > 6 ? ', and others' : ''}).`;
    if (k.ginDraws.length) t += ` ${k.ginDraws.length === 1 ? 'One of them gives' : `${k.ginDraws.length} of them give`} gin.`;
  }
  return t;
}

/** At a low knock limit, a low loose card can be part of the deadwood you knock with; a high one cannot. */
function limitLine(a: Card, b: Card, limit: number): string[] {
  if (limit <= 0 || limit >= 10) return [];
  const lo = VALUE[a] < VALUE[b] ? a : b;
  const hi = lo === a ? b : a;
  if (VALUE[lo] > limit || VALUE[hi] <= limit) return [];
  return [`At this knock limit of ${limit}, the ${cardName(lo)} could stay in your hand as part of the deadwood you knock with. The ${cardName(hi)} never can: it has to be melded or thrown before you can knock.`];
}

/** The four checks comparing discarding `a` with discarding `b` from the same 11-card hand. Biggest difference first. */
export function compareDiscards(s: HandState, p: number, st: Uint8Array, a: Card, b: Card): WhySection[] {
  const hand = s.hands[p];
  const ia = improveCheck(s, p, hand, a, b, st);
  const ib = improveCheck(s, p, hand, b, a, st);
  const sa = safetyCheck(s, p, a, st);
  const sb = safetyCheck(s, p, b, st);
  const ka = knockCheck(hand.filter((x) => x !== a), st, s.knockLimit);
  const kb = knockCheck(hand.filter((x) => x !== b), st, s.knockLimit);
  // an out that would make a meld anyway is worth much less to the card you keep
  const outsA = ia.inMeld ? 6 : ia.outs.length - 0.5 * ia.suspect.length - 0.6 * ia.riding.length;
  const outsB = ib.inMeld ? 6 : ib.outs.length - 0.5 * ib.suspect.length - 0.6 * ib.riding.length;
  const sections: WhySection[] = [
    {
      title: 'What could still improve each card',
      lines: [improveLine(a, ia), improveLine(b, ib)],
      weight: Math.abs(outsA - outsB) * 2,
      // keeping the card with more outs is better, so throwing the one with fewer outs is favoured
      favours: outsA < outsB ? 1 : outsA > outsB ? -1 : 0,
    },
    {
      title: 'How safe each discard is',
      lines: [safetyLine(a, sa), safetyLine(b, sb)],
      weight: Math.abs(sa.score - sb.score) * 1.5,
      favours: sa.score < sb.score ? 1 : sa.score > sb.score ? -1 : 0,
    },
    {
      title: 'What each costs if your opponent goes out',
      lines: [
        VALUE[a] === VALUE[b]
          ? `Both cards count ${VALUE[a]} against you.`
          : `The ${cardName(a)} counts ${VALUE[a]} against you while you hold it; the ${cardName(b)} counts ${VALUE[b]}.`,
        ...limitLine(a, b, s.knockLimit),
      ],
      weight: Math.abs(VALUE[a] - VALUE[b]),
      favours: VALUE[a] > VALUE[b] ? 1 : VALUE[a] < VALUE[b] ? -1 : 0,
    },
    {
      title: s.knockLimit === 0 ? 'Your gin chances afterwards' : 'Your knock and gin chances afterwards',
      lines: [knockLine(a, ka, s.knockLimit), knockLine(b, kb, s.knockLimit)],
      weight: Math.abs(ka.knockDraws.length - kb.knockDraws.length) * 2 + Math.abs(ka.ginDraws.length - kb.ginDraws.length) * 3,
      favours: ka.knockDraws.length + ka.ginDraws.length > kb.knockDraws.length + kb.ginDraws.length ? 1 : ka.knockDraws.length + ka.ginDraws.length < kb.knockDraws.length + kb.ginDraws.length ? -1 : 0,
    },
  ];
  return sections.sort((x, y) => y.weight - x.weight);
}

/** After the hand: would this discard actually have melded in the opponent's hand? */
export function hindsight(oppHand: readonly Card[], c: Card): string {
  const melds = deadwood([...oppHand, c]) < deadwood(oppHand) + VALUE[c];
  return melds ? `As it turned out, your opponent could use the ${cardName(c)}.` : `As it turned out, your opponent had no use for the ${cardName(c)}.`;
}
