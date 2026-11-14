import { type Card, VALUE, rankOf, suitOf } from './cards';

// Meld search over a hand of at most 11 cards. Melds are bitmasks over hand positions.
// Hot path for simulation: module-level scratch buffers, no allocation per call.

const MAXN = 11;
const memo = new Int16Array(1 << MAXN);
const stamp = new Uint32Array(1 << MAXN);
let curStamp = 0;
const meldsOf: number[][] = Array.from({ length: MAXN }, () => []);
const vals = new Int32Array(MAXN);
let meldCount = 0;
const allMelds: number[] = [];
const posOf = new Int8Array(52);
const rankCnt = new Int8Array(13);

function addMeld(mask: number): void {
  allMelds.push(mask);
  meldCount++;
  for (let m = mask; m; m &= m - 1) meldsOf[31 - Math.clz32(m & -m)].push(mask);
}

/** Build the meld list for these cards. */
function prepare(cards: readonly Card[]): void {
  const n = cards.length;
  curStamp++;
  meldCount = 0;
  allMelds.length = 0;
  for (let i = 0; i < n; i++) meldsOf[i].length = 0;
  posOf.fill(-1);
  rankCnt.fill(0);
  for (let i = 0; i < n; i++) {
    const c = cards[i];
    posOf[c] = i;
    vals[i] = VALUE[c];
    rankCnt[c % 13]++;
  }
  // sets
  for (let r = 0; r < 13; r++) {
    if (rankCnt[r] < 3) continue;
    let full = 0;
    for (let s = 0; s < 4; s++) {
      const p = posOf[s * 13 + r];
      if (p >= 0) full |= 1 << p;
    }
    addMeld(full);
    if (rankCnt[r] === 4) {
      for (let m = full; m; m &= m - 1) addMeld(full ^ (m & -m));
    }
  }
  // runs (ace low only)
  for (let s = 0; s < 4; s++) {
    const base = s * 13;
    let start = -1;
    for (let r = 0; r <= 13; r++) {
      const has = r < 13 && posOf[base + r] >= 0;
      if (has) {
        if (start < 0) start = r;
      } else if (start >= 0) {
        const len = r - start;
        if (len >= 3) {
          for (let a = start; a + 3 <= r; a++) {
            let mask = (1 << posOf[base + a]) | (1 << posOf[base + a + 1]);
            for (let b = a + 2; b < r; b++) {
              mask |= 1 << posOf[base + b];
              addMeld(mask);
            }
          }
        }
        start = -1;
      }
    }
  }
}

function best(mask: number): number {
  if (mask === 0) return 0;
  if (stamp[mask] === curStamp) return memo[mask];
  const low = mask & -mask;
  const i = 31 - Math.clz32(low);
  let res = vals[i] + best(mask ^ low);
  const ms = meldsOf[i];
  for (let k = 0; k < ms.length; k++) {
    const m = ms[k];
    if ((m & mask) === m) {
      const v = best(mask ^ m);
      if (v < res) res = v;
    }
  }
  stamp[mask] = curStamp;
  memo[mask] = res;
  return res;
}

/** Minimum deadwood points for a hand (any size up to 11). */
export function deadwood(cards: readonly Card[]): number {
  prepare(cards);
  if (meldCount === 0) {
    let s = 0;
    for (let i = 0; i < cards.length; i++) s += vals[i];
    return s;
  }
  return best((1 << cards.length) - 1);
}

/** For an 11-card hand: out[i] = minimum deadwood after discarding cards[i]. */
export function discardDeadwoods(cards: readonly Card[], out: Int16Array | number[]): void {
  prepare(cards);
  const full = (1 << cards.length) - 1;
  if (meldCount === 0) {
    let s = 0;
    for (let i = 0; i < cards.length; i++) s += vals[i];
    for (let i = 0; i < cards.length; i++) out[i] = s - vals[i];
    return;
  }
  for (let i = 0; i < cards.length; i++) out[i] = best(full ^ (1 << i));
}

export interface Arrangement {
  deadwood: number;
  melds: Card[][];
  deadwoodCards: Card[];
}

const isSet = (m: Card[]) => rankOf(m[0]) === rankOf(m[1]);

/**
 * Best arrangement of a hand into melds. Ties are broken toward arrangements that
 * give the opponent fewer layoff chances (sets of four, then sets, then runs).
 */
export function arrange(cards: readonly Card[]): Arrangement {
  prepare(cards);
  const full = (1 << cards.length) - 1;
  const target = best(full);
  const melds: Card[][] = [];
  const dead: Card[] = [];
  let mask = full;
  while (mask) {
    const low = mask & -mask;
    const i = 31 - Math.clz32(low);
    // candidates: melds containing i that keep optimality; prefer 4-sets, sets, long runs last
    let chosen = 0;
    let chosenScore = -1;
    const here = best(mask);
    for (const m of meldsOf[i]) {
      if ((m & mask) !== m) continue;
      if (best(mask ^ m) !== here) continue;
      const cs = maskCards(cards, m);
      const score = isSet(cs) ? (cs.length === 4 ? 3 : 2) : 1;
      if (score > chosenScore) {
        chosenScore = score;
        chosen = m;
      }
    }
    if (chosen && !(vals[i] + best(mask ^ low) === here && chosenScore < 0)) {
      melds.push(maskCards(cards, chosen).sort((a, b) => a - b));
      mask ^= chosen;
    } else {
      dead.push(cards[i]);
      mask ^= low;
    }
  }
  dead.sort((a, b) => VALUE[b] - VALUE[a] || a - b);
  return { deadwood: target, melds, deadwoodCards: dead };
}

function maskCards(cards: readonly Card[], mask: number): Card[] {
  const out: Card[] = [];
  for (let m = mask; m; m &= m - 1) out.push(cards[31 - Math.clz32(m & -m)]);
  return out;
}

/** True if adding `card` to the hand lets it join a meld in some optimal arrangement. */
export function cardMelds(hand: readonly Card[], card: Card): boolean {
  const before = deadwood(hand);
  const after = deadwood([...hand, card]);
  return after < before + VALUE[card];
}

export function isValidMeld(cs: readonly Card[]): boolean {
  if (cs.length < 3) return false;
  const sorted = [...cs].sort((a, b) => a - b);
  if (sorted.every((c) => rankOf(c) === rankOf(sorted[0]))) {
    return cs.length <= 4 && new Set(sorted.map(suitOf)).size === cs.length;
  }
  if (!sorted.every((c) => suitOf(c) === suitOf(sorted[0]))) return false;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] !== sorted[i - 1] + 1) return false;
  return true;
}

/**
 * Cards the defender may lay off on the knocker's melds, and the defender's best result.
 * Returns the minimum defender deadwood and which cards were laid off.
 */
export function bestLayoff(defender: readonly Card[], knockerMelds: readonly Card[][]): { deadwood: number; laidOff: Card[]; arrangement: Arrangement } {
  // For each defender card: can it be laid off, and does it need another defender card laid off first?
  const inHand = new Set(defender);
  const layable = new Map<Card, Card | -1>(); // card -> prerequisite card (or -1)
  for (const m of knockerMelds) {
    const sorted = [...m].sort((a, b) => a - b);
    if (rankOf(sorted[0]) === rankOf(sorted[1])) {
      if (sorted.length === 3) {
        const r = rankOf(sorted[0]);
        for (let s = 0; s < 4; s++) {
          const c = s * 13 + r;
          if (inHand.has(c)) layable.set(c, -1);
        }
      }
    } else {
      const suit = suitOf(sorted[0]);
      let prev: Card | -1 = -1;
      for (let r = rankOf(sorted[0]) - 1; r >= 0; r--) {
        const c = suit * 13 + r;
        if (!inHand.has(c)) break;
        if (!layable.has(c) || prev === -1) layable.set(c, prev);
        prev = c;
      }
      prev = -1;
      for (let r = rankOf(sorted[sorted.length - 1]) + 1; r < 13; r++) {
        const c = suit * 13 + r;
        if (!inHand.has(c)) break;
        if (!layable.has(c) || prev === -1) layable.set(c, prev);
        prev = c;
      }
    }
  }
  const cand = [...layable.keys()];
  let bestDw = Infinity;
  let bestOff: Card[] = [];
  for (let sub = 0; sub < 1 << cand.length; sub++) {
    const off = new Set<Card>();
    for (let i = 0; i < cand.length; i++) if (sub & (1 << i)) off.add(cand[i]);
    let ok = true;
    for (const c of off) {
      const pre = layable.get(c)!;
      if (pre !== -1 && !off.has(pre)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    const rest = defender.filter((c) => !off.has(c));
    const dw = deadwood(rest);
    if (dw < bestDw || (dw === bestDw && off.size < bestOff.length)) {
      bestDw = dw;
      bestOff = [...off];
    }
  }
  const rest = defender.filter((c) => !bestOff.includes(c));
  return { deadwood: bestDw, laidOff: bestOff, arrangement: arrange(rest) };
}
