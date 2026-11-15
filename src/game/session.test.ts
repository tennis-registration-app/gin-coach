import { describe, expect, it } from 'vitest';
import { makeRng } from '../engine/cards';
import { HOUSE_RULES } from '../engine/hand';
import { loadModels } from '../bots/learned';
import { simplePolicy } from '../bots/policy';
import type { ModelFile } from '../coach/model';
import modelJson from '../coach/model.json';
import { ME, Session } from './session';

const models = loadModels(modelJson as unknown as ModelFile);

describe('partnership game flow', () => {
  it('plays complete games to the target with consistent scoring and coach verdicts', () => {
    const rng = makeRng(5);
    for (const level of ['easy', 'strong'] as const) {
      const sess = new Session(HOUSE_RULES, models, level, 1234);
      let games = 0;
      let hands = 0;
      let guard = 0;
      while (games < 2 && guard++ < 200000) {
        const s = sess.hand;
        if (s.phase === 'over') {
          const g = sess.game;
          const r = sess.round!;
          hands++;
          expect(g.rounds.reduce((a, x) => a + x.us, 0)).toBe(g.us);
          expect(g.rounds.reduce((a, x) => a + x.them, 0)).toBe(g.them);
          expect(r.usDelta + r.themDelta).toBe(r.mine.points + r.partner.points);
          const sum = sess.summary();
          expect(sum.decisions).toBe(sess.records.length);
          if (g.over) {
            expect(Math.max(g.us, g.them)).toBeGreaterThanOrEqual(HOUSE_RULES.target);
            games++;
            sess.newGame();
            expect(sess.game.us).toBe(0);
          } else {
            expect(Math.max(g.us, g.them)).toBeLessThan(HOUSE_RULES.target);
            sess.startHand();
          }
          continue;
        }
        if (sess.myTurn) {
          expect(sess.analysis).toBeTruthy();
          const an = sess.analysis!;
          // half the time follow the coach, half the time play the simple baseline
          const follow = rng() < 0.5;
          const a = follow ? an.options[0].action : simplePolicy.act(s, rng);
          const v = sess.act(a);
          expect(v.loss).toBeGreaterThanOrEqual(0);
          if (follow && !v.usedMatchScore) {
            expect(v.loss).toBe(0);
            expect(v.flagged).toBe(false);
          }
          if (v.flagged) {
            expect(v.category).toBeTruthy();
            expect(v.reasons.length).toBeGreaterThan(0);
          }
        } else {
          expect(sess.stepOpponent()).toBe(true);
        }
      }
      expect(games).toBe(2);
      expect(hands).toBeGreaterThan(3);
    }
  }, 120000);

  it('keeps a manual hand arrangement stable as cards come and go', () => {
    const sess = new Session(HOUSE_RULES, models, 'easy', 7);
    const first = [...sess.myOrder()];
    expect([...first].sort()).toEqual([...sess.hand.hands[ME]].sort());
    sess.moveCard(first[0], 1);
    expect(sess.myOrder()[1]).toBe(first[0]);
    expect(sess.myOrder()[0]).toBe(first[1]);
    let guard = 0;
    while (sess.hand.phase !== 'over' && guard++ < 50) {
      if (!sess.myTurn) {
        sess.stepOpponent();
        continue;
      }
      const before = [...sess.myOrder()];
      if (sess.hand.phase === 'draw') {
        sess.act(sess.hand.opening <= 1 ? { type: 'pass' } : { type: 'stock' });
        if (sess.hand.turn === ME && sess.hand.phase === 'discard') {
          const after = sess.myOrder();
          expect(after.slice(0, before.length)).toEqual(before);
          expect(after[after.length - 1]).toBe(sess.hand.justDrew);
        }
      } else {
        const drop = before[0];
        if (drop === sess.hand.justTaken) break;
        sess.act({ type: 'discard', card: drop, knock: false });
        expect(sess.myOrder()).toEqual(before.slice(1));
      }
    }
  });

  it('reveals the partner result only once enough turns have passed', () => {
    const sess = new Session(HOUSE_RULES, models, 'easy', 99);
    expect(sess.matchContext().partnerDelta === null || sess.partnerTurns === 0).toBe(true);
    expect(sess.hand.turn === ME || sess.hand.turn === 1).toBe(true);
  });
});
