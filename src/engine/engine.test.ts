import { describe, expect, it } from 'vitest';
import { type Card, VALUE, fullDeck, makeRng, parseCards as P, shuffle } from './cards';
import { HOUSE_RULES, HandState, showdown } from './hand';
import { arrange, bestLayoff, deadwood, discardDeadwoods, isValidMeld } from './melds';
import { heuristicPolicy, playHand, simplePolicy } from '../bots/policy';

const R = HOUSE_RULES;

describe('deadwood and melds', () => {
  it('counts card values', () => {
    expect(deadwood(P('As Kh 5d'))).toBe(16);
  });
  it('finds sets and runs', () => {
    expect(deadwood(P('7s 7h 7d 2c'))).toBe(2);
    expect(deadwood(P('4h 5h 6h 7h Kc'))).toBe(10);
    expect(deadwood(P('As 2s 3s'))).toBe(0);
  });
  it('does not wrap king-ace', () => {
    expect(deadwood(P('Qs Ks As'))).toBe(21);
  });
  it('resolves overlapping set and run for minimum deadwood', () => {
    // 7s can go in the set of sevens or the spade run; best leaves only the 5s or less
    // run 5-9 of spades leaves 7h 7d (14); the set of sevens would leave 5 6 8 9 (28)
    expect(deadwood(P('7s 7h 7d 5s 6s 8s 9s'))).toBe(14);
  });
  it('splits a four-card set to feed a run when better', () => {
    // 8s 8h 8d 8c + 6c 7c : best is 8s8h8d + 6c7c8c = 0
    expect(deadwood(P('8s 8h 8d 8c 6c 7c'))).toBe(0);
  });
  it('recognises gin and eleven-card gin', () => {
    expect(deadwood(P('As 2s 3s 4s 9h 9d 9c Jd Qd Kd'))).toBe(0);
    expect(deadwood(P('As 2s 3s 4s 9h 9d 9c 9s Jd Qd Kd'))).toBe(0);
  });
  it('arrange returns a consistent arrangement', () => {
    const hand = P('As 2s 3s 4s 9h 9d 9c Jd Qd 5h');
    const a = arrange(hand);
    expect(a.deadwood).toBe(25);
    expect(a.melds.every(isValidMeld)).toBe(true);
    expect(a.melds.flat().length + a.deadwoodCards.length).toBe(10);
  });
});

// brute-force reference
function brute(cards: Card[]): number {
  const n = cards.length;
  const melds: number[] = [];
  for (let m = 1; m < 1 << n; m++) {
    const cs = cards.filter((_, i) => m & (1 << i));
    if (cs.length >= 3 && isValidMeld(cs)) melds.push(m);
  }
  const total = cards.reduce((s, c) => s + VALUE[c], 0);
  const val = (m: number) => cards.reduce((s, c, i) => s + (m & (1 << i) ? VALUE[c] : 0), 0);
  let best = 0;
  const rec = (start: number, used: number, got: number) => {
    if (got > best) best = got;
    for (let k = start; k < melds.length; k++) if (!(melds[k] & used)) rec(k + 1, used | melds[k], got + val(melds[k]));
  };
  rec(0, 0, 0);
  return total - best;
}

describe('property tests', () => {
  it('deadwood matches brute force on 3000 random hands', () => {
    const rng = makeRng(42);
    for (let t = 0; t < 3000; t++) {
      // bias toward meld-rich hands by drawing from a reduced deck
      const deck = shuffle(fullDeck(), rng).filter((c) => (t % 2 ? c % 13 < 8 : true));
      const hand = deck.slice(0, 10 + (t % 2));
      expect(deadwood(hand)).toBe(brute(hand));
      const a = arrange(hand);
      expect(a.deadwood).toBe(brute(hand));
      expect(a.deadwoodCards.reduce((s, c) => s + VALUE[c], 0)).toBe(a.deadwood);
      expect(a.melds.every(isValidMeld)).toBe(true);
    }
  });
  it('discardDeadwoods matches deadwood of each 10-card subset', () => {
    const rng = makeRng(7);
    const out = new Int16Array(11);
    for (let t = 0; t < 300; t++) {
      const hand = shuffle(fullDeck(), rng)
        .filter((c) => c % 13 < 9)
        .slice(0, 11);
      discardDeadwoods(hand, out);
      const copy = Array.from(out);
      for (let i = 0; i < 11; i++) expect(copy[i]).toBe(brute(hand.filter((_, j) => j !== i)));
    }
  });
  it('layoff result is optimal versus brute force over layoff subsets', () => {
    const rng = makeRng(99);
    let checked = 0;
    for (let t = 0; t < 4000 && checked < 150; t++) {
      const deck = shuffle(fullDeck(), rng).filter((c) => c % 13 < 9);
      const knocker = deck.slice(0, 10);
      const defender = deck.slice(10, 20);
      const ka = arrange(knocker);
      if (ka.melds.length === 0) continue;
      checked++;
      const lo = bestLayoff(defender, ka.melds);
      // brute force: try every subset of defender cards; valid if knocker melds + subset can be partitioned
      // so each knocker meld extended by its assigned cards is still valid
      let best = Infinity;
      for (let m = 0; m < 1 << 10; m++) {
        const off = defender.filter((_, i) => m & (1 << i));
        if (off.length > 6) continue;
        if (!canAssign(off, ka.melds)) continue;
        const dw = brute(defender.filter((_, i) => !(m & (1 << i))));
        if (dw < best) best = dw;
      }
      expect(lo.deadwood).toBe(best);
    }
    expect(checked).toBeGreaterThan(100);
  }, 60000);
  it('cards are conserved and results are well formed over 3000 bot hands', () => {
    const rng = makeRng(2026);
    for (let t = 0; t < 3000; t++) {
      const s = HandState.deal(R, t % 2, rng);
      playHand(s, t % 3 ? [heuristicPolicy, simplePolicy] : [simplePolicy, heuristicPolicy], rng);
      const all = [...s.hands[0], ...s.hands[1], ...s.stock, ...s.discard];
      expect(all.length).toBe(52);
      expect(new Set(all).size).toBe(52);
      const r = s.result!;
      expect(r).toBeTruthy();
      if (r.kind === 'draw') {
        expect(s.stock.length).toBe(R.stockDrawAt);
        expect(r.points).toBe(0);
      } else {
        expect(r.points).toBeGreaterThanOrEqual(0);
        if (r.kind !== 'biggin') expect(r.knockerDeadwood).toBeLessThanOrEqual(s.knockLimit);
        if (s.knockLimit === 0) expect(['gin', 'biggin']).toContain(r.kind);
      }
    }
  });
});

function canAssign(off: Card[], melds: Card[][]): boolean {
  if (off.length === 0) return true;
  // assign each laid-off card to a meld; check each extended meld is valid
  const k = melds.length;
  const total = Math.pow(k, off.length);
  for (let code = 0; code < total; code++) {
    const ext = melds.map((m) => [...m]);
    let x = code;
    for (const c of off) {
      ext[x % k].push(c);
      x = Math.floor(x / k);
    }
    if (ext.every(isValidMeld)) return true;
  }
  return false;
}

describe('scoring under house rules', () => {
  const gin10 = P('As 2s 3s 4s 9h 9d 9c Jd Qd Kd');
  it('gin scores 25 plus deadwood, with no layoffs', () => {
    const def = P('5s 9s Kh Ks 2h 3h 4h 7c 7d 7h'); // 5s and 9s could lay off but may not
    const r = showdown(gin10, def, 0, false, R);
    expect(r.kind).toBe('gin');
    expect(r.winner).toBe(0);
    expect(r.points).toBe(25 + 5 + 9 + 10 + 10);
  });
  it('eleven-card gin scores 50 plus deadwood', () => {
    const big = P('As 2s 3s 4s 9h 9d 9c 9s Jd Qd Kd');
    const def = P('5s Kh Ks 2h 3h 4h 7c 7d 7h 8c');
    const r = showdown(big, def, 1, true, R);
    expect(r.kind).toBe('biggin');
    expect(r.winner).toBe(1);
    expect(r.points).toBe(50 + 5 + 10 + 10 + 8);
  });
  it('ordinary knock scores the deadwood difference after layoffs', () => {
    const knocker = P('As 2s 3s 9h 9d 9c Jd Qd Kd 4h'); // deadwood 4
    const def = P('4s 9s Kh Ks 2c 3c 4c 7c 7d 7h'); // lays off 4s and 9s, leaving K K = 20
    const r = showdown(knocker, def, 0, false, R);
    expect(r.kind).toBe('knock');
    expect(r.laidOff.sort()).toEqual(P('4s 9s').sort());
    expect(r.points).toBe(20 - 4);
  });
  it('undercut scores 10 plus the difference, including a tie', () => {
    const knocker = P('As 2s 3s 9h 9d 9c Jd Qd Kd 6h'); // deadwood 6
    const def = P('4s 5s 2h 2c 2d 7c 7d 7h Tc 3c'); // 4s lays off, 5s lays off after it; left 10+3 = 13 -> no undercut
    expect(showdown(knocker, def, 0, false, R).kind).toBe('knock');
    const def2 = P('4s 5s 2h 2c 2d 7c 7d 7h 8h 3c'); // lay off 4s 5s, left 3c = 3 (7c7d7h set, 8h laid? no) -> 8h+3c=11
    expect(showdown(knocker, def2, 0, false, R).defenderDeadwood).toBe(11);
    const def3 = P('4s 5s 2h 2c 2d 7c 7d 7h 9s 3c'); // 4s,5s,9s off; left 3 -> undercut by 3
    const r3 = showdown(knocker, def3, 0, false, R);
    expect(r3.kind).toBe('undercut');
    expect(r3.winner).toBe(1);
    expect(r3.points).toBe(10 + 3);
    const def4 = P('4s 5s 2h 2c 2d 7c 7d 7h 9s 6c'); // left 6 = tie -> undercut for 10
    const r4 = showdown(knocker, def4, 0, false, R);
    expect(r4.kind).toBe('undercut');
    expect(r4.points).toBe(10);
  });
});

describe('Oklahoma hand flow', () => {
  const deckWithUpcard = (up: string): Card[] => {
    const u = P(up)[0];
    const rest = fullDeck().filter((c) => c !== u);
    return [...rest.slice(0, 20), u, ...rest.slice(20)];
  };
  it('upcard sets the knock limit; face cards mean 10; ace means gin only', () => {
    expect(HandState.fromDeck(R, 0, deckWithUpcard('7d')).knockLimit).toBe(7);
    expect(HandState.fromDeck(R, 0, deckWithUpcard('Qd')).knockLimit).toBe(10);
    expect(HandState.fromDeck(R, 0, deckWithUpcard('Ah')).knockLimit).toBe(0);
    expect(HandState.fromDeck(R, 0, deckWithUpcard('As')).multiplier).toBe(1); // spades do not double
    expect(HandState.fromDeck({ ...R, oklahoma: false }, 0, deckWithUpcard('3d')).knockLimit).toBe(10);
  });
  it('opening: non-dealer is offered the upcard, then dealer, then non-dealer draws stock', () => {
    const s = HandState.fromDeck(R, 0, deckWithUpcard('7d'));
    expect(s.turn).toBe(1);
    expect(s.legalActions().map((a) => a.type)).toEqual(['take', 'pass']);
    s.apply({ type: 'pass' });
    expect(s.turn).toBe(0);
    expect(s.legalActions().map((a) => a.type)).toEqual(['take', 'pass']);
    s.apply({ type: 'pass' });
    expect(s.turn).toBe(1);
    expect(s.legalActions().map((a) => a.type)).toEqual(['stock']);
    s.apply({ type: 'stock' });
    expect(s.hands[1].length).toBe(11);
    expect(s.phase).toBe('discard');
    // the drawn card is tracked for display until the discard
    expect(s.justDrew).toBe(s.hands[1][10]);
    expect(s.justTaken).toBe(-1);
    s.apply({ type: 'discard', card: s.hands[1][0], knock: false });
    expect(s.justDrew).toBe(-1);
  });
  it('cannot discard the card just taken, and cannot knock above the limit', () => {
    const up0 = P('3d')[0];
    const rest = P('Ks Qh 9d 7c 5s 2h Jd 8c 6s 4h').concat(fullDeck().filter((c) => !P('Ks Qh 9d 7c 5s 2h Jd 8c 6s 4h 3d').includes(c)));
    const s = HandState.fromDeck(R, 0, [...rest.slice(0, 20), up0, ...rest.slice(20)]);
    s.apply({ type: 'take' });
    const up = P('3d')[0];
    expect(s.legalActions().some((a) => a.type === 'discard' && a.card === up)).toBe(false);
    expect(() => s.apply({ type: 'discard', card: up, knock: false })).toThrow();
    const other = s.hands[1].find((c) => c !== up)!;
    expect(() => s.apply({ type: 'discard', card: other, knock: true })).toThrow();
  });
  it('hand is a draw when two stock cards remain', () => {
    const s = HandState.fromDeck(R, 0, deckWithUpcard('Ah')); // gin only, so no knocks
    s.apply({ type: 'pass' });
    s.apply({ type: 'pass' });
    let guard = 0;
    while (s.phase !== 'over' && guard++ < 200) {
      if (s.phase === 'draw') s.apply({ type: 'stock' });
      else {
        // discard the card just drawn (last in hand) so nobody improves
        const c = s.hands[s.turn][s.hands[s.turn].length - 1];
        s.apply({ type: 'discard', card: c, knock: false });
      }
    }
    expect(s.result!.kind).toBe('draw');
    expect(s.stock.length).toBe(2);
  });
});
