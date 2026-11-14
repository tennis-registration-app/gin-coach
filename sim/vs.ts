// Head-to-head: npx tsx sim/vs.ts [hands]
import { makeRng } from '../src/engine/cards';
import { HOUSE_RULES, HandState } from '../src/engine/hand';
import { heuristicPolicy, playHand, simplePolicy, type Policy } from '../src/bots/policy';

export function headToHead(a: Policy, b: Policy, hands: number, seed = 1) {
  const rng = makeRng(seed);
  let aw = 0, bw = 0, dr = 0, ap = 0, bp = 0;
  const kinds: Record<string, number> = {};
  for (let i = 0; i < hands; i++) {
    // each deal is played twice with seats swapped to cancel card luck
    const dseed = (rng() * 2 ** 31) | 0;
    for (let seat = 0; seat < 2; seat++) {
      const s = HandState.deal(HOUSE_RULES, i % 2, makeRng(dseed));
      playHand(s, seat === 0 ? [a, b] : [b, a], rng);
      const r = s.result!;
      kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      if (r.winner < 0) dr++;
      else if ((r.winner === 0) === (seat === 0)) { aw++; ap += r.points; }
      else { bw++; bp += r.points; }
    }
  }
  const n = hands * 2;
  return { n, aWinPct: (100 * aw) / (aw + bw), aw, bw, draws: dr, aPtsPerHand: (ap - bp) / n, kinds };
}

if (process.argv[1].endsWith('vs.ts')) {
  const n = Number(process.argv[2] || 5000);
  const t = Date.now();
  console.log(heuristicPolicy.name, 'vs', simplePolicy.name, headToHead(heuristicPolicy, simplePolicy, n));
  console.log('hands/s', Math.round((2 * n * 1000) / (Date.now() - t)));
}
