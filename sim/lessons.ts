// Build the data behind the in-app lessons: npx tsx sim/lessons.ts [hands]
// Plays the trained bot against itself and records (a) what actually happens when you knock,
// against the opponent's true hand, and (b) what the coach's models prefer, by situation.
import { readFileSync, writeFileSync } from 'node:fs';
import { type Card, makeRng } from '../src/engine/cards';
import { HOUSE_RULES, HandState, showdownValue } from '../src/engine/hand';
import { deadwood, discardDeadwoods } from '../src/engine/melds';
import { loadModels, makeLearned } from '../src/bots/learned';
import { analyze, pileCardFit } from '../src/coach/analyze';
import { knockCheck } from '../src/coach/facts';
import { cardStatus } from '../src/bots/policy';

const N = Number(process.argv[2] || 20000);
const m = loadModels(JSON.parse(readFileSync('src/coach/model.json', 'utf8')));
const bot = makeLearned(m);
const rng = makeRng(2026);
const stageOf = (stock: number) => (stock >= 22 ? 0 : stock >= 12 ? 1 : 2);
type Cell = { n: number; win: number; undercut: number; pts: number; prefer: number; edge: number };
const cell = (): Cell => ({ n: 0, win: 0, undercut: 0, pts: 0, prefer: 0, edge: 0 });
// knock[stage][deadwood 1..10]
const knock: Cell[][] = [0, 1, 2].map(() => Array.from({ length: 11 }, cell));
// gin[ginDraws 0..4+] : how often the coach prefers knocking, by live gin cards
const gin: Cell[] = Array.from({ length: 5 }, cell);
// pile[fit kind][stage]: how often the coach prefers taking
const pile: Record<string, { n: number; take: number }[]> = { new: [], swap: [], none: [] };
for (const k of Object.keys(pile)) pile[k] = [0, 1, 2].map(() => ({ n: 0, take: 0 }));
const dws = new Int16Array(11);
let drawSeen = 0;
for (let h = 0; h < N; h++) {
  const s = HandState.deal(HOUSE_RULES, h % 2, rng);
  while (s.phase !== 'over') {
    const p = s.turn;
    const hand = s.hands[p];
    if (s.phase === 'discard' && deadwood(hand) > 0) {
      discardDeadwoods(hand, dws);
      let minDw = 999, minCard: Card = -1;
      for (let i = 0; i < hand.length; i++) if (hand[i] !== s.justTaken && dws[i] < minDw) { minDw = dws[i]; minCard = hand[i]; }
      if (minDw > 0 && minDw <= s.knockLimit) {
        const H = hand.filter((c) => c !== minCard);
        const v = showdownValue(H, s.hands[1 - p], false, HOUSE_RULES, s.multiplier);
        const an = analyze(s, m);
        const bestKnock = an.options.find((o) => o.action.type === 'discard' && o.action.knock);
        const bestWait = an.options.find((o) => o.action.type === 'discard' && !o.action.knock);
        const c = knock[stageOf(s.stock.length)][minDw];
        c.n++; c.pts += v; if (v > 0) c.win++; else c.undercut++;
        if (bestKnock && bestWait) {
          const edge = bestKnock.ev - bestWait.ev;
          c.edge += edge; if (edge > 0) c.prefer++;
          const k = knockCheck(H, cardStatus(s, p).slice(), s.knockLimit);
          const g = gin[Math.min(4, k.ginDraws.length)];
          g.n++; g.edge += edge; if (edge > 0) g.prefer++;
        }
      }
    } else if (s.phase === 'draw' && s.opening === 3 && s.topDiscard >= 0 && drawSeen++ % 12 === 0) {
      const fit = pileCardFit(hand, s.topDiscard).kind;
      const an = analyze(s, m);
      const c = pile[fit][stageOf(s.stock.length)];
      c.n++; if (an.options[0].action.type === 'take') c.take++;
    }
    s.apply(bot.act(s, rng));
  }
}
const r1 = (x: number) => Math.round(x * 10) / 10;
const out = {
  hands: N,
  rules: { undercut: HOUSE_RULES.undercutBonus, gin: HOUSE_RULES.ginBonus },
  stages: ['Early (22 or more in the stock)', 'Middle (12 to 21)', 'Late (11 or fewer)'],
  knock: knock.map((row) => row.map((c, d) => (d === 0 || c.n < 30 ? null : { n: c.n, winPct: Math.round((100 * c.win) / c.n), undercutPct: Math.round((100 * c.undercut) / c.n), avgPts: r1(c.pts / c.n), coachKnockPct: Math.round((100 * c.prefer) / c.n), edge: r1(c.edge / c.n) }))),
  gin: gin.map((c) => (c.n < 30 ? null : { n: c.n, coachKnockPct: Math.round((100 * c.prefer) / c.n), edge: r1(c.edge / c.n) })),
  pile: Object.fromEntries(Object.entries(pile).map(([k, row]) => [k, row.map((c) => (c.n < 30 ? null : { n: c.n, takePct: Math.round((100 * c.take) / c.n) }))])),
};
writeFileSync('src/coach/lessons.json', JSON.stringify(out));
console.log(JSON.stringify(out, null, 0).slice(0, 3000));
