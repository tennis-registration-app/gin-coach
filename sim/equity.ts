// Build the game-win table: npx tsx sim/equity.ts <model.json> <hands>
import { readFileSync, writeFileSync } from 'node:fs';
import { makeRng } from '../src/engine/cards';
import { HOUSE_RULES, HandState } from '../src/engine/hand';
import { playHand } from '../src/bots/policy';
import { loadModels, makeLearned } from '../src/bots/learned';

const [model, handsStr] = process.argv.slice(2);
const bot = makeLearned(loadModels(JSON.parse(readFileSync(model, 'utf8'))));
const rng = makeRng(77);
const hist = new Map<number, number>();
const N = Number(handsStr);
for (let i = 0; i < N; i++) {
  const s = playHand(HandState.deal(HOUSE_RULES, i % 2, rng), [bot, bot], rng);
  const r = s.result!;
  const v = r.winner < 0 ? 0 : r.winner === 0 ? r.points : -r.points;
  // symmetrise
  hist.set(v, (hist.get(v) || 0) + 0.5);
  hist.set(-v, (hist.get(-v) || 0) + 0.5);
}
const vals = [...hist.keys()].sort((a, b) => a - b);
const prob = vals.map((v) => hist.get(v)! / N);
// distribution of a round (two matchups): points to us, points to them
const round = new Map<string, number>();
for (let a = 0; a < vals.length; a++) for (let b = 0; b < vals.length; b++) {
  const us = Math.max(vals[a], 0) + Math.max(vals[b], 0), th = Math.max(-vals[a], 0) + Math.max(-vals[b], 0);
  const k = us + ',' + th;
  round.set(k, (round.get(k) || 0) + prob[a] * prob[b]);
}
const outcomes = [...round.entries()].map(([k, p]) => ({ us: +k.split(',')[0], th: +k.split(',')[1], p }));
const p00 = round.get('0,0') || 0;
const TARGET = 200;
const W = new Float64Array(TARGET * TARGET);
const win = (u: number, t: number) => (u >= TARGET || t >= TARGET ? (u > t ? 1 : u < t ? 0 : 0.5) : W[u * TARGET + t]);
for (let sum = 2 * TARGET - 2; sum >= 0; sum--) {
  for (let u = Math.max(0, sum - TARGET + 1); u <= Math.min(TARGET - 1, sum); u++) {
    const t = sum - u;
    let acc = 0;
    for (const o of outcomes) if (o.us || o.th) acc += o.p * win(u + o.us, t + o.th);
    W[u * TARGET + t] = acc / (1 - p00);
  }
}
const step = 2, n = TARGET / step;
const data: number[] = [];
for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) data.push(Math.round(1000 * W[i * step * TARGET + j * step]));
writeFileSync('src/coach/equityTable.json', JSON.stringify({ step, n, target: TARGET, data }));
const mean = vals.reduce((s, v, i) => s + Math.abs(v) * prob[i], 0);
console.log('hands', N, 'avg points per hand', mean.toFixed(1), 'W(0,0)', win(0, 0).toFixed(3), 'W(150,100)', win(150, 100).toFixed(3), 'W(100,150)', win(100, 150).toFixed(3), 'W(190,150)', win(190, 150).toFixed(3));
