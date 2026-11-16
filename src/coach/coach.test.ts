import { describe, expect, it } from 'vitest';
import { type Card, fullDeck, makeRng, parseCards as P, shuffle } from '../engine/cards';
import { HOUSE_RULES, HandState } from '../engine/hand';
import { loadModels } from '../bots/learned';
import { heuristicPolicy } from '../bots/policy';
import type { ModelFile } from './model';
import modelJson from './model.json';
import { analyze, judge, pileCardFit, realOuts } from './analyze';
import { improveCheck, knockCheck, safetyCheck } from './facts';
import { fullDeck as allCards } from '../engine/cards';
import { cardStatus } from '../bots/policy';
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

  it('does not count outs through a partner that is locked in a better meld', () => {
    // A-2-3-4-5 of spades is a run; the 3c pairs with the 3s only on paper
    const s = stateWith('9h 9c 8c 7s 7h 4s 5s 3s As 3c', '2s', 'Td');
    const st = cardStatus(s, s.turn).slice();
    const hand = s.hands[s.turn];
    const c3 = P('3c')[0];
    const c8 = P('8c')[0];
    // holding the 3c (having thrown the 8c): a third three would not meld it
    expect(realOuts(hand.filter((x) => x !== c8), c3, st)).toEqual([]);
    // holding the 8c (having thrown the 3c): the 7c completes 7-8-9 of clubs
    expect(realOuts(hand.filter((x) => x !== c3), c8, st)).toContain(P('7c')[0]);
    const an = analyze(s, m);
    const v = judge(s, an, { type: 'discard', card: c3, knock: false });
    expect(v.reasons.join(' ')).not.toMatch(/3♥|3♦/);
  });

  // Two hands from alpha testing, rebuilt from their hand logs.
  function build(o: { mine: string; pile: string; oppKnown: string; upcard: string; myDisc: string; oppDisc: string; myDecl: string; oppDecl: string; takes: [number, number] }): HandState {
    const mine = P(o.mine);
    const pile = P(o.pile);
    const ok = P(o.oppKnown);
    const s = new HandState(HOUSE_RULES);
    const rest = allCards().filter((c) => !mine.includes(c) && !pile.includes(c) && !ok.includes(c));
    s.hands = [mine.slice(), [...ok, ...rest.slice(0, 10 - ok.length)]];
    s.stock = rest.slice(10 - ok.length);
    s.discard = pile.slice();
    s.upcard = P(o.upcard)[0];
    s.setKnockLimit();
    s.dealer = 1;
    s.turn = 0;
    s.phase = 'discard';
    s.opening = 3;
    for (const c of ok) s.known[1][c] = 1;
    s.takes = o.takes;
    s.discards = [P(o.myDisc), P(o.oppDisc)];
    s.declined = [P(o.myDecl), P(o.oppDecl)];
    s.turnsTaken = s.discards[0].length + s.discards[1].length;
    return s;
  }
  const names = (cs: number[]) => cs.map((c) => P('As 2s 3s 4s 5s 6s 7s 8s 9s Ts Js Qs Ks Ah 2h 3h 4h 5h 6h 7h 8h 9h Th Jh Qh Kh Ad 2d 3d 4d 5d 6d 7d 8d 9d Td Jd Qd Kd Ac 2c 3c 4c 5c 6c 7c 8c 9c Tc Jc Qc Kc').indexOf(c)).length;

  it('alpha hand 1: ace of hearts against nine of clubs', () => {
    const s = build({ mine: '7d 8d 9d 6s 6h 6d 2d Jc Jd 9c Ah', pile: 'Ac Kc 4s 9h 5c 8c 7c 5h', oppKnown: 'Qs Ts', upcard: 'Qs', myDisc: 'Kc Ts 9h 8c 7c', oppDisc: 'Ac 4s Jc 5c 6d 5h', myDecl: 'Ac 4s 5c 5h', oppDecl: 'Kc 9h 8c 7c', takes: [2, 2] });
    const st = cardStatus(s, 0).slice();
    const [ah, c9] = [P('Ah')[0], P('9c')[0]];
    // the 9c cannot be used by the opponent in any meld; the ace can
    expect(safetyCheck(s, 0, c9, st).usable).toEqual([]);
    expect(safetyCheck(s, 0, ah, st).usable.length).toBeGreaterThan(0);
    // the 9c's run needs the 10c, which is doubtful because the opponent picked up a ten; the 8c and 9h are gone
    const imp = improveCheck(s, 0, s.hands[0], c9, ah, st);
    expect(imp.outs).toContain(P('Tc')[0]);
    expect(imp.suspect.map((x) => x.card)).toContain(P('Tc')[0]);
    expect(imp.gone.map((g) => g.card)).toContain(P('9h')[0]);
    expect(improveCheck(s, 0, s.hands[0], ah, c9, st).outs).toEqual([]);
    expect(names(imp.outs)).toBe(imp.outs.length);
    const v = judge(s, analyze(s, m), { type: 'discard', card: ah, knock: false });
    expect(v.best.label).toMatch(/9♣/);
    expect(v.why.map((w) => w.title)).toContain('How safe each discard is');
    expect(v.why.flatMap((w) => w.lines).join(' ')).toMatch(/provably safe/);
  });

  it('alpha hand 2: three of clubs against eight of clubs', () => {
    const s = build({ mine: '9h 9c 8c 7s 7h 4s 5s 3s As 2s 3c', pile: 'Qs 6s Th Tc Js 6h 5c 8s 2c 8d 6d Jc', oppKnown: 'Ks', upcard: 'Th', myDisc: 'Ks 6s Th Js 5c 2c 6d', oppDisc: 'Qs 5s Tc 6h 8s 8d Jc', myDecl: 'Qs Tc 6h 8s 8d Jc', oppDecl: '6s Th Js 5c 2c 6d', takes: [2, 1] });
    const st = cardStatus(s, 0).slice();
    const hand = s.hands[0];
    const [c3, c8] = [P('3c')[0], P('8c')[0]];
    // the 3c has no outs because the 3s is locked in the spade run
    const i3 = improveCheck(s, 0, hand, c3, c8, st);
    expect(i3.outs).toEqual([]);
    expect(i3.shared).toEqual({ partner: P('3s')[0], locked: true, alsoWants: [] });
    // throwing the 8c leaves a knock after a third nine; throwing the 3c does not
    const k8 = knockCheck(hand.filter((c) => c !== c8), st, s.knockLimit);
    const k3 = knockCheck(hand.filter((c) => c !== c3), st, s.knockLimit);
    expect(k8.knockDraws).toContain(P('9s')[0]);
    expect(k8.knockDraws).toContain(P('9d')[0]);
    expect(k3.knockDraws).toEqual([]);
    const v = judge(s, analyze(s, m), { type: 'discard', card: c3, knock: false });
    expect(v.flagged).toBe(true);
    expect(v.best.label).toMatch(/8♣/);
    expect(v.reasons.join(' ')).toMatch(/knock next turn/);
    expect(v.reasons.join(' ')).not.toMatch(/3♥|3♦/);
  });

  it('explains every decision, including ones the coach agrees with', () => {
    const rng = makeRng(21);
    let withWhy = 0;
    let total = 0;
    for (let t = 0; t < 30; t++) {
      const s = HandState.deal(HOUSE_RULES, t % 2, rng);
      while (s.phase !== 'over') {
        const an = analyze(s, m);
        const a = heuristicPolicy.act(s, rng);
        if (!an.forced) {
          const v = judge(s, an, a);
          total++;
          if (v.why.length) withWhy++;
          for (const sec of v.why) for (const line of sec.lines) expect(line).not.toMatch(/undefined|NaN/);
        }
        s.apply(a);
      }
    }
    expect(withWhy / total).toBeGreaterThan(0.95);
  });

  it('never flags a discard as a mistake when no check supports the coach', () => {
    const rng = makeRng(77);
    let flagged = 0;
    let unproven = 0;
    for (let t = 0; t < 60; t++) {
      const s = HandState.deal(HOUSE_RULES, t % 2, rng);
      while (s.phase !== 'over') {
        const an = analyze(s, m);
        // a deliberately mixed player: sometimes random legal discards
        let a = heuristicPolicy.act(s, rng);
        if (s.phase === 'discard' && a.type === 'discard' && !a.knock && rng() < 0.4) {
          const legal = s.hands[s.turn].filter((c) => c !== s.justTaken);
          a = { type: 'discard', card: legal[(rng() * legal.length) | 0], knock: false };
        }
        if (!an.forced) {
          const v = judge(s, an, a);
          if (v.headline.startsWith('Unproven')) {
            unproven++;
            expect(v.flagged).toBe(false);
          }
          if (v.flagged && a.type === 'discard' && !a.knock && v.best.action.type === 'discard' && !v.best.action.knock) {
            flagged++;
            const tally = v.why.find((w) => w.title === 'How the checks line up')!;
            expect(tally.lines.join(' ')).toMatch(/Favouring the /);
          }
        }
        s.apply(a);
      }
    }
    expect(flagged).toBeGreaterThan(20);
    console.log('flagged', flagged, 'unproven', unproven);
  });

  it('tells a clean new meld from a swap that breaks another meld (alpha hand 3)', () => {
    const hand = P('Ts Th 9s 8h 8d 8c 4h 3h 3c 2c');
    // the 9h makes 8-9-10 of hearts only by breaking the set of eights
    const swap = pileCardFit(hand, P('9h')[0]);
    expect(swap.kind).toBe('swap');
    expect(swap.joins.sort()).toEqual(P('8h 9h Th').sort());
    expect(swap.breaks.sort()).toEqual(P('8h 8d 8c').sort());
    // a third ten is a clean new meld; a king is nothing
    expect(pileCardFit(hand, P('Td')[0]).kind).toBe('new');
    expect(pileCardFit(hand, P('8s')[0]).kind).toBe('new');
    expect(pileCardFit(hand, P('Kd')[0]).kind).toBe('none');
  });

  it('game-win table is sane', () => {
    const T = HOUSE_RULES.target;
    expect(gameWinChance(0, 0, T)).toBeCloseTo(0.5, 1);
    expect(gameWinChance(T * 0.75, T * 0.25, T)).toBeGreaterThan(0.75);
    expect(gameWinChance(T * 0.25, T * 0.75, T)).toBeLessThan(0.25);
    expect(gameWinChance(T + 10, T - 50, T)).toBe(1);
  });
});
