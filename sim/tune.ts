// Random search over heuristic parameters: npx tsx sim/tune.ts <seed> <iters>
import { makeRng } from '../src/engine/cards';
import { DEFAULT_PARAMS, makeHeuristic, simplePolicy, type HeuristicParams } from '../src/bots/policy';
import { headToHead } from './vs';

const seed = Number(process.argv[2] || 1);
const iters = Number(process.argv[3] || 40);
const rng = makeRng(seed * 7717);
const pick = (lo: number, hi: number) => lo + rng() * (hi - lo);
let best: HeuristicParams = { ...DEFAULT_PARAMS };
let bestScore = -1e9;
for (let i = 0; i < iters; i++) {
  const p: HeuristicParams = i === 0 ? { ...DEFAULT_PARAMS } : {
    wConn: pick(0, 4), connDecay: pick(0, 1), wDanger: pick(0, 25), wSingle: pick(0, 0.8),
    takeToKnock: rng() < 0.5, lateTurn: Math.round(pick(8, 30)), lateKnockMax: Math.round(pick(0, 10)),
    ginOuts: 99, ginMinStock: 99,
  };
  const r = headToHead(makeHeuristic(p), simplePolicy, 1500, 5);
  const score = r.aPtsPerHand;
  if (score > bestScore) { bestScore = score; best = p; console.log(JSON.stringify({ score: +score.toFixed(3), win: +r.aWinPct.toFixed(1), p })); }
}
