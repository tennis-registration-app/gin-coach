import { describe, expect, it } from 'vitest';
import { type Card, fullDeck, makeRng, parseCards as P, shuffle } from '../engine/cards';
import { HOUSE_RULES, HandState } from '../engine/hand';
import { loadModels } from '../bots/learned';
import { heuristicPolicy } from '../bots/policy';
import type { ModelFile } from './model';
import modelJson from './model.json';
import { analyze, judge } from './analyze';
import { gameWinChance } from './equity';

const m = loadModels(modelJson as unknown as ModelFile);

/** Build a state where player 1 (non-dealer) holds `mine` and is about to discard after drawing `drawn`. */
function stateWith(mine: string, drawn: string, upcard: string): HandState {
  const hand = P(mine);
  const d = P(drawn)[0];
  const up = P(upcard)[0];
  const rest = fullDeck().filter((c) => !hand.includes(c) && c !== d && c !== up);
  shuffle(rest, makeRng(3));
  // deck: non-dealer 10, dealer 10, upcard, stock (drawn from the end)
  const deck = [...hand, ...rest.slice(0, 10), up, ...rest.slice(10), d];
  const s = HandState.fromDeck(HOUSE_RULES, 0, deck);
  s.apply({ type: 'pass' });
  s.apply({ type: 'pass' });
  s.apply({ type: 'stock' });
  return s;
}

describe('coach', () => {
  it('prefers gin when gin is available and flags a missed gin', () => {
    const s = stateWith('As 2s 3s 4s 9h 9d 9c Jd Qd Kd', '7c', 'Kc');
    const an = analyze(s, m);
    expect(an.options[0].action).toEqual({ type: 'discard', card: P('7c')[0], knock: true });
    const v = judge(s, an, { type: 'discard', card: P('7c')[0], knock: false });
    expect(v.flagged).toBe(true);
    expect(v.category).toBe('knock-late');
  });

  it('flags throwing a card out of a made meld', () => {
    const s = stateWith('5s 6s 7s 9h 9d 9c Kd 2c 8h Qc', '3d', 'Kc');
    const an = analyze(s, m);
    const v = judge(s, an, { type: 'discard', card: P('9h')[0], knock: false });
    expect(v.flagged).toBe(true);
    expect(v.category).toBe('broke-combo');
    expect(v.loss).toBeGreaterThan(3);
    const ok = judge(s, an, an.options[0].action);
    expect(ok.loss).toBe(0);
    expect(ok.flagged).toBe(false);
  });

  it('never uses hidden information: swapping unseen cards between the opponent and the stock changes nothing', () => {
    const rng = makeRng(11);
    let checked = 0;
    for (let t = 0; t < 40; t++) {
      const s = HandState.deal(HOUSE_RULES, t % 2, rng);
      const stop = 2 + ((rng() * 14) | 0);
      let moves = 0;
      while (s.phase !== 'over' && moves < stop) {
        s.apply(heuristicPolicy.act(s, rng));
        moves++;
      }
      if (s.phase === 'over') continue;
      const p = s.turn;
      const a1 = analyze(s, m);
      const alt = s.clone();
      const opp = alt.hands[1 - p];
      const hidden: Card[] = opp.filter((c) => !alt.known[1 - p][c]);
      const keep = opp.filter((c) => alt.known[1 - p][c]);
      const pool = shuffle([...hidden, ...alt.stock], rng);
      alt.hands[1 - p] = [...keep, ...pool.slice(0, hidden.length)];
      alt.stock = pool.slice(hidden.length);
      const a2 = analyze(alt, m);
      expect(a2.options.map((o) => [o.label, o.ev.toFixed(6)])).toEqual(a1.options.map((o) => [o.label, o.ev.toFixed(6)]));
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('game-win table is sane', () => {
    expect(gameWinChance(0, 0, 200)).toBeCloseTo(0.5, 1);
    expect(gameWinChance(150, 50, 200)).toBeGreaterThan(0.75);
    expect(gameWinChance(50, 150, 200)).toBeLessThan(0.25);
    expect(gameWinChance(210, 150, 200)).toBe(1);
  });
});
