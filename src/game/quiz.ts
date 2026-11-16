import { type Card, type Rng, cardName } from '../engine/cards';
import { HandState } from '../engine/hand';

// Card-tracking quizzes: questions about cards you have seen, asked mid-hand when the
// tracking aids are switched off.

export interface Quiz {
  question: string;
  options: string[];
  answer: number;
  explain: string;
}

const RANK_PLURAL = ['aces', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings'];
const names = (cs: Card[]) => (cs.length ? cs.map(cardName).join(', ') : 'none');

/** Build a quiz for player p from what p has seen, or null if the hand is too young to ask anything. */
export function makeQuiz(s: HandState, p: number, rng: Rng): Quiz | null {
  const pile = s.discard;
  if (pile.length < 4) return null;
  const mine = s.hands[p];
  const inPile = new Set(pile);
  const oppKnown: Card[] = [];
  for (let c = 0; c < 52; c++) if (s.known[1 - p][c]) oppKnown.push(c);
  const pick = <T>(xs: T[]): T => xs[(rng() * xs.length) | 0];
  const kind = rng();

  // which card did the opponent pick up?
  if (oppKnown.length && kind < 0.25) {
    const right = pick(oppKnown);
    const decoys: Card[] = [];
    for (let tries = 0; decoys.length < 3 && tries < 200; tries++) {
      const c = (rng() * 52) | 0;
      if (c === right || mine.includes(c) || inPile.has(c) || oppKnown.includes(c) || decoys.includes(c)) continue;
      decoys.push(c);
    }
    if (decoys.length === 3) {
      const opts = [right, ...decoys].sort((a, b) => a - b);
      return {
        question: 'Which of these cards has your opponent picked up from the pile and kept?',
        options: opts.map(cardName),
        answer: opts.indexOf(right),
        explain: `Your opponent has picked up and still holds: ${names(oppKnown)}.`,
      };
    }
  }

  // is a card you might be waiting for still live?
  if (kind < 0.65) {
    const cands: Card[] = [];
    for (const c of mine) {
      const r = c % 13;
      for (let s2 = 0; s2 < 4; s2++) cands.push(s2 * 13 + r);
      if (r > 0) cands.push(c - 1);
      if (r < 12) cands.push(c + 1);
    }
    const pool = [...new Set(cands)].filter((c) => !mine.includes(c));
    const gone = pool.filter((c) => inPile.has(c) || oppKnown.includes(c));
    const live = pool.filter((c) => !inPile.has(c) && !oppKnown.includes(c));
    const useGone = gone.length > 0 && (live.length === 0 || rng() < 0.5);
    const from = useGone ? gone : live;
    if (from.length) {
      const c = pick(from);
      const where = inPile.has(c) ? 'It is in the discard pile.' : oppKnown.includes(c) ? 'Your opponent picked it up.' : 'It has not appeared: it is in the stock or hidden in your opponent\'s hand.';
      return {
        question: `Could you still draw the ${cardName(c)}? It is gone if it is in the discard pile or you saw your opponent take it.`,
        options: ['Yes, it has not appeared', 'No, it is gone'],
        answer: useGone ? 1 : 0,
        explain: where,
      };
    }
  }

  // how many of a rank are in the pile?
  const r = pick(mine) % 13;
  const there = pile.filter((c) => c % 13 === r);
  return {
    question: `How many ${RANK_PLURAL[r]} are in the discard pile?`,
    options: ['0', '1', '2', '3'],
    answer: Math.min(3, there.length),
    explain: there.length ? `In the pile: ${names(there)}.` : `No ${RANK_PLURAL[r]} have been discarded yet.`,
  };
}
