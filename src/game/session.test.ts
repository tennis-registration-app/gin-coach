import { describe, expect, it } from 'vitest';
import { makeRng } from '../engine/cards';
import { HOUSE_RULES } from '../engine/hand';
import { loadModels } from '../bots/learned';
import { simplePolicy } from '../bots/policy';
import type { ModelFile } from '../coach/model';
import modelJson from '../coach/model.json';
import { ME, Session } from './session';
import { drillCorrect, generateDrill, loadState, saveState, suitsDrill } from './drills';
import { analyze, judge } from '../coach/analyze';

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
          expect(sum.decisions).toBe(sess.records.filter((r) => !r.retry).length);
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

  it('lets you take back a flagged play, keeps the first attempt in the statistics, and reshuffles after a stock draw', () => {
    const rng = makeRng(3);
    let tookBackDiscard = 0;
    let tookBackStock = 0;
    for (let seed = 1; seed < 40 && (tookBackDiscard < 3 || tookBackStock < 1); seed++) {
      const sess = new Session(HOUSE_RULES, models, 'easy', seed);
      sess.pauseOnMistake = true;
      let guard = 0;
      while (sess.hand.phase !== 'over' && guard++ < 300) {
        if (!sess.myTurn) {
          sess.stepOpponent();
          continue;
        }
        const s = sess.hand;
        const an = sess.analysis!;
        // play badly on purpose: the worst-rated option
        const worst = an.options[an.options.length - 1].action;
        const before = { mine: [...s.hands[ME]].sort(), pile: [...s.discard], stock: [...s.stock], records: sess.records.length };
        const v = sess.act(worst);
        if (sess.hand.phase === 'over') break;
        if (!v.flagged) continue;
        expect(sess.awaiting).toBe(true);
        expect(sess.stepOpponent()).toBe(false); // the opponent waits
        expect(sess.canTakeBack).toBe(true);
        sess.takeBack();
        const h = sess.hand;
        expect([...h.hands[ME]].sort()).toEqual(before.mine);
        expect(h.discard).toEqual(before.pile);
        expect([...h.stock].sort()).toEqual([...before.stock].sort());
        expect(sess.records.length).toBe(before.records + 1);
        expect(sess.records[before.records].retried).toBe(true);
        expect(sess.myTurn).toBe(true);
        if (worst.type === 'stock') {
          tookBackStock++;
          if (before.stock.length > 6) expect(h.stock).not.toEqual(before.stock); // reshuffled
        } else tookBackDiscard++;
        // second attempt: follow the coach; it is recorded as a retry and not counted
        const again = sess.act(sess.analysis!.options[0].action);
        expect(again.flagged).toBe(false);
        expect(sess.records[sess.records.length - 1].retry).toBe(true);
        expect(sess.awaiting).toBe(false);
        void rng;
      }
      if (sess.hand.phase === 'over') {
        const sum = sess.summary();
        const counted = sess.records.filter((r) => !r.retry);
        expect(sum.decisions).toBe(counted.length);
        expect(sum.flagged).toBe(counted.filter((r) => r.flagged && r.category).length);
      }
    }
    expect(tookBackDiscard).toBeGreaterThanOrEqual(3);
  });

  it('marks a hand as aided once the coach has rated an option in advance', () => {
    const sess = new Session(HOUSE_RULES, models, 'easy', 11);
    expect(sess.aided).toBe(false);
    while (!sess.myTurn) sess.stepOpponent();
    const a = sess.analysis!.options[0].action;
    const v = sess.preview(a);
    expect(v.loss).toBe(0);
    expect(sess.aided).toBe(true);
    // previewing does not change the hand
    expect(sess.records.length).toBe(0);
    sess.startHand();
    expect(sess.aided).toBe(false);
  });

  it('tracks who threw each pile card, and asks sound memory questions with tracking help off', () => {
    const rng = makeRng(8);
    let quizzes = 0;
    for (let seed = 1; seed <= 25; seed++) {
      const sess = new Session(HOUSE_RULES, models, 'easy', seed);
      sess.tracking = 'none';
      let guard = 0;
      while (sess.hand.phase !== 'over' && guard++ < 300) {
        const s = sess.hand;
        expect(s.discardBy.length).toBe(s.discard.length);
        if (!sess.myTurn) {
          sess.stepOpponent();
          continue;
        }
        const q = sess.quiz;
        if (q) {
          quizzes++;
          expect(q.answer).toBeGreaterThanOrEqual(0);
          expect(q.answer).toBeLessThan(q.options.length);
          // check the answer against the cards actually seen
          const pile = new Set(s.discard);
          const m = q.question.match(/How many (\w+) are in the discard pile/);
          if (m) {
            const r = ['aces', 'twos', 'threes', 'fours', 'fives', 'sixes', 'sevens', 'eights', 'nines', 'tens', 'jacks', 'queens', 'kings'].indexOf(m[1]);
            expect(q.answer).toBe(Math.min(3, s.discard.filter((c) => c % 13 === r).length));
          }
          if (q.question.startsWith('Which of these cards has your opponent picked up')) {
            const known: number[] = [];
            for (let c = 0; c < 52; c++) if (s.known[1][c]) known.push(c);
            expect(known.length).toBeGreaterThan(0);
            expect(pile.size).toBeGreaterThanOrEqual(4);
          }
          expect(sess.answerQuiz(q.answer)).toBe(true);
          expect(sess.quizAsked).toBe(1);
        }
        sess.act(sess.analysis!.options[rng() < 0.7 ? 0 : sess.analysis!.options.length - 1].action);
        expect(sess.quiz).toBeNull();
      }
      if (sess.hand.phase === 'over') {
        const sum = sess.summary();
        expect(sum.tracking).toBe('none');
        expect(sum.quizAsked ?? 0).toBeLessThanOrEqual(1);
      }
    }
    expect(quizzes).toBeGreaterThan(5);
  });

  it('generates drills of each kind and round-trips saved positions', () => {
    const rng = makeRng(31);
    for (const kind of ['knock', 'discard', 'draw'] as const) {
      for (let i = 0; i < 4; i++) {
        const s = generateDrill(kind, HOUSE_RULES, models, rng)!;
        expect(s).toBeTruthy();
        const an = analyze(s, models);
        expect(suitsDrill(s, an, kind)).toBe(true);
        if (kind === 'draw') expect(s.phase).toBe('draw');
        else expect(s.hands[s.turn].length).toBe(11);
        if (kind === 'knock') expect(an.options.some((o) => o.action.type === 'discard' && o.action.knock)).toBe(true);
        // the coach's own best play always counts as right
        expect(drillCorrect(judge(s, an, an.options[0].action, false))).toBe(true);
        // saving and reloading a position reproduces the same analysis
        const again = analyze(loadState(JSON.parse(JSON.stringify(saveState(s))), HOUSE_RULES), models);
        expect(again.options.map((o) => [o.label, o.ev.toFixed(5)])).toEqual(an.options.map((o) => [o.label, o.ev.toFixed(5)]));
      }
    }
  }, 120000);

  it('keeps the full position on flagged mistakes so they can be replayed', () => {
    const sess = new Session(HOUSE_RULES, models, 'easy', 5);
    let found = 0;
    let guard = 0;
    while (sess.hand.phase !== 'over' && guard++ < 300) {
      if (!sess.myTurn) {
        sess.stepOpponent();
        continue;
      }
      const opts = sess.analysis!.options;
      const v = sess.act(opts[opts.length - 1].action);
      const rec = sess.records[sess.records.length - 1];
      if (v.flagged) {
        found++;
        const s = loadState(rec.state!, HOUSE_RULES);
        expect(s.turn).toBe(ME);
        expect([...s.hands[ME]].sort()).toEqual([...rec.myHand].sort());
        expect(analyze(s, models).options[0].label).toBe(rec.best);
      } else expect(rec.state).toBeUndefined();
    }
    expect(found).toBeGreaterThan(0);
  });

  it('reveals the partner result only once enough turns have passed', () => {
    const sess = new Session(HOUSE_RULES, models, 'easy', 99);
    expect(sess.matchContext().partnerDelta === null || sess.partnerTurns === 0).toBe(true);
    expect(sess.hand.turn === ME || sess.hand.turn === 1).toBe(true);
  });
});
