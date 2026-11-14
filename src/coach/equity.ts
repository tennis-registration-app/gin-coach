import table from './equityTable.json';

// Chance that "us" wins a game to `target`, given both team scores, assuming evenly matched
// teams. Built by sim/equity.ts from the distribution of hand results in bot self-play.
const T = table as { step: number; n: number; target: number; data: number[] };

export function gameWinChance(us: number, them: number, target: number): number {
  if (us >= target || them >= target) return us > them ? 1 : us < them ? 0 : 0.5;
  // the table is built for a 200-point game; rescale other targets
  const k = T.target / target;
  const i = Math.min(T.n - 1, Math.max(0, Math.round((us * k) / T.step)));
  const j = Math.min(T.n - 1, Math.max(0, Math.round((them * k) / T.step)));
  return T.data[i * T.n + j] / 1000;
}
