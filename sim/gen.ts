// Self-play data generation: npx tsx sim/gen.ts <tag> <hands> <seed> [modelPath] [eps]
import { readFileSync, writeFileSync } from 'node:fs';
import { type Card, makeRng } from '../src/engine/cards';
import { type Action, HOUSE_RULES, HandState, showdownValue } from '../src/engine/hand';
import { deadwood, discardDeadwoods } from '../src/engine/melds';
import { cardStatus, heuristicPolicy, scoreDiscards } from '../src/bots/policy';
import { loadModels, makeLearned } from '../src/bots/learned';
import { NK, NV, kFeatures, makeCtx, vFeatures } from '../src/coach/features';
import { holdWeights } from '../src/coach/mc';

const [tag, handsStr, seedStr, modelPath, epsStr] = process.argv.slice(2);
const hands = Number(handsStr), seed = Number(seedStr), eps = Number(epsStr ?? 0.2);
const rng = makeRng(seed);
const base = modelPath && modelPath !== 'none' ? makeLearned(loadModels(JSON.parse(readFileSync(modelPath, 'utf8')))) : heuristicPolicy;
const vRows: number[] = [], kRows: number[] = [];
const fv = new Float32Array(NV), fk = new Float32Array(NK), dws = new Int16Array(11);
let nv = 0, nk = 0;
for (let h = 0; h < hands; h++) {
  const s = HandState.deal(HOUSE_RULES, h % 2, rng);
  const pending: { p: number; f: number[] }[] = [];
  while (s.phase !== 'over') {
    const p = s.turn;
    let a: Action = base.act(s, rng);
    if (s.phase === 'discard' && a.type === 'discard') {
      const hand = s.hands[p];
      const ctx = makeCtx(s, p, cardStatus(s, p), holdWeights(s, p));
      discardDeadwoods(hand, dws);
      let minDw = 999, minCard: Card = -1;
      for (let i = 0; i < hand.length; i++) if (hand[i] !== s.justTaken && dws[i] < minDw) { minDw = dws[i]; minCard = hand[i]; }
      const gin = minDw === 0;
      // knock sample: counterfactual value of knocking now against the true opposing hand
      if (!gin && minDw <= s.knockLimit) {
        const H = hand.filter((c) => c !== minCard);
        kFeatures(H, ctx, fk);
        const v = showdownValue(H, s.hands[1 - p], false, HOUSE_RULES, s.multiplier);
        kRows.push(...fk, v > 0 ? 1 : 0, v < 0 ? 1 : 0, v > 0 ? v / 50 : 0, v < 0 ? -v / 50 : 0);
        nk++;
        // explore the knock decision both ways
        if (rng() < eps) a = a.knock ? { type: 'discard', card: a.card, knock: false } : { type: 'discard', card: minCard, knock: true };
      }
      if (!gin && !a.knock && rng() < eps) {
        const sc = scoreDiscards(s);
        const pick = sc[(rng() * Math.min(5, sc.length)) | 0];
        a = { type: 'discard', card: pick.card, knock: false };
      }
      if (!a.knock) {
        const H = hand.filter((c) => c !== (a as { card: Card }).card);
        vFeatures(H, (a as { card: Card }).card, ctx, fv);
        pending.push({ p, f: Array.from(fv) });
      }
    }
    s.apply(a);
  }
  const r = s.result!;
  for (const { p, f } of pending) {
    const win = r.winner === p, lose = r.winner === 1 - p;
    vRows.push(...f, win ? 1 : 0, lose ? 1 : 0, win ? r.points / 50 : 0, lose ? r.points / 50 : 0);
    nv++;
  }
}
writeFileSync(`data/v_${tag}.bin`, Buffer.from(Float32Array.from(vRows).buffer));
writeFileSync(`data/k_${tag}.bin`, Buffer.from(Float32Array.from(kRows).buffer));
console.log(tag, 'v rows', nv, 'k rows', nk, 'deadwood check', deadwood([0, 1, 2]));
