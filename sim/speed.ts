// Time the coach's analysis: npx tsx sim/speed.ts
import { readFileSync } from 'node:fs';
import { makeRng } from '../src/engine/cards';
import { HOUSE_RULES, HandState } from '../src/engine/hand';
import { heuristicPolicy } from '../src/bots/policy';
import { loadModels } from '../src/bots/learned';
import { analyze } from '../src/coach/analyze';
const m = loadModels(JSON.parse(readFileSync('src/coach/model.json', 'utf8')));
const rng = makeRng(1);
const t: Record<string, number[]> = { draw: [], discard: [] };
for (let h = 0; h < 60; h++) {
  const s = HandState.deal(HOUSE_RULES, h % 2, rng);
  while (s.phase !== 'over') {
    const t0 = performance.now();
    const an = analyze(s, m, { us: 100, them: 120, partnerDelta: null, target: 200 });
    t[an.kind].push(performance.now() - t0);
    s.apply(heuristicPolicy.act(s, rng));
  }
}
for (const k of Object.keys(t)) {
  const v = t[k].sort((a, b) => a - b);
  console.log(k, 'n', v.length, 'median ms', v[v.length >> 1].toFixed(1), 'p95 ms', v[Math.floor(v.length * 0.95)].toFixed(1), 'max', v[v.length - 1].toFixed(1));
}
