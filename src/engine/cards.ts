// Cards are integers 0..51. rank = c % 13 (0 = Ace ... 12 = King), suit = floor(c / 13).
export type Card = number;

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
export const SUITS = ['♠', '♥', '♦', '♣'];
export const SUIT_NAMES = ['spades', 'hearts', 'diamonds', 'clubs'];

export const rankOf = (c: Card): number => c % 13;
export const suitOf = (c: Card): number => (c / 13) | 0;
export const makeCard = (rank: number, suit: number): Card => suit * 13 + rank;

/** Deadwood value: ace 1, face cards 10, others pip value. */
export const VALUE: number[] = Array.from({ length: 52 }, (_, c) => Math.min((c % 13) + 1, 10));
export const valueOf = (c: Card): number => VALUE[c];

export const cardName = (c: Card): string => RANKS[rankOf(c)] + SUITS[suitOf(c)];
export const cardNames = (cs: readonly Card[]): string => cs.map(cardName).join(' ');

/** Parse "7♦", "7d", "10h", "Ks". */
export function parseCard(s: string): Card {
  const t = s.trim().toUpperCase();
  const suitCh = t[t.length - 1];
  const rankStr = t.slice(0, -1).replace('T', '10');
  const suit = ['♠', '♥', '♦', '♣'].indexOf(suitCh) >= 0 ? ['♠', '♥', '♦', '♣'].indexOf(suitCh) : 'SHDC'.indexOf(suitCh);
  const rank = RANKS.indexOf(rankStr);
  if (suit < 0 || rank < 0) throw new Error('bad card: ' + s);
  return makeCard(rank, suit);
}
export const parseCards = (s: string): Card[] => s.trim().split(/\s+/).filter(Boolean).map(parseCard);

/** Small fast seeded PRNG (mulberry32). */
export type Rng = () => number;
export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(arr: T[], rng: Rng): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = arr[i];
    arr[i] = arr[j];
    arr[j] = t;
  }
  return arr;
}

export const fullDeck = (): Card[] => Array.from({ length: 52 }, (_, i) => i);

/** Sort by suit then rank (for display) */
export const sortCards = (cs: readonly Card[]): Card[] => [...cs].sort((a, b) => a - b);
