// npx tsx sim/lv.ts <model.json> <hands> <mode: strong|expert> [opp: simple|heur|model.json] [seed]
import { readFileSync } from 'node:fs';
import { heuristicPolicy, simplePolicy } from '../src/bots/policy';
import { loadModels, makeLearned } from '../src/bots/learned';
import { headToHead } from './vs';
const [model, handsStr, mode, opp = 'simple', seed = '1'] = process.argv.slice(2);
const m = loadModels(JSON.parse(readFileSync(model, 'utf8')));
const a = makeLearned(m, { lookahead: mode === 'expert' });
const b = opp === 'simple' ? simplePolicy : opp === 'heur' ? heuristicPolicy : makeLearned(loadModels(JSON.parse(readFileSync(opp, 'utf8'))), { name: 'Strong(' + opp + ')' });
const t = Date.now();
const r = headToHead(a, b, Number(handsStr), Number(seed));
const se = 100 * Math.sqrt(0.25 / (r.aw + r.bw));
console.log(JSON.stringify({ a: a.name, b: b.name, hands: r.n, winPct: +r.aWinPct.toFixed(2), winPctSE: +se.toFixed(2), ptsPerHand: +r.aPtsPerHand.toFixed(2), draws: r.draws, kinds: r.kinds, secs: (Date.now() - t) / 1000 }));
