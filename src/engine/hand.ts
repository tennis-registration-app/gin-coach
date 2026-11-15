import { type Card, type Rng, VALUE, fullDeck, rankOf, shuffle } from './cards';
import { arrange, bestLayoff, deadwood, type Arrangement } from './melds';

export interface Rules {
  /** Bonus for going gin (plus opponent's deadwood). */
  ginBonus: number;
  /** Bonus for an eleven-card gin (plus opponent's deadwood). */
  bigGinBonus: number;
  /** Bonus for an undercut (plus the deadwood difference). */
  undercutBonus: number;
  /** Team score that ends a game. */
  target: number;
  /** Oklahoma: first upcard sets the maximum knock count. If false, always 10. */
  oklahoma: boolean;
  /** Oklahoma: an ace upcard means gin only. */
  aceGinOnly: boolean;
  /** Oklahoma: spade upcard doubles the hand. */
  spadeDoubles: boolean;
  /** Defender may lay off against a gin hand. */
  layoffOnGin: boolean;
  /** Hand is a draw when this many stock cards remain after a discard. */
  stockDrawAt: number;
}

/** The house rules of the user's table. */
export const HOUSE_RULES: Rules = {
  ginBonus: 25,
  bigGinBonus: 50,
  undercutBonus: 10,
  target: 200,
  oklahoma: true,
  aceGinOnly: true,
  spadeDoubles: false,
  layoffOnGin: false,
  stockDrawAt: 2,
};

export type Action =
  | { type: 'take' } // take the top discard (or the upcard)
  | { type: 'pass' } // decline the upcard (opening only)
  | { type: 'stock' } // draw from stock
  | { type: 'discard'; card: Card; knock: boolean } // knock=true ends the hand (gin if deadwood 0)
  | { type: 'biggin' }; // declare eleven-card gin

export type ResultKind = 'knock' | 'gin' | 'biggin' | 'undercut' | 'draw';

export interface HandResult {
  kind: ResultKind;
  /** Player who scores (-1 on a draw). */
  winner: number;
  points: number;
  knocker: number;
  knockerDeadwood: number;
  defenderDeadwood: number;
  knockerArrangement?: Arrangement;
  defenderArrangement?: Arrangement;
  laidOff: Card[];
}

/** Opening stages: 0 = non-dealer offered upcard, 1 = dealer offered upcard, 2 = non-dealer must draw stock, 3 = normal play. */
export class HandState {
  hands: [Card[], Card[]] = [[], []];
  stock: Card[] = [];
  discard: Card[] = [];
  dealer = 0;
  turn = 0;
  phase: 'draw' | 'discard' | 'over' = 'draw';
  opening = 0;
  knockLimit = 10;
  multiplier = 1;
  upcard: Card = -1;
  /** Card the player to move just took from the discard pile (cannot be discarded this turn), else -1. */
  justTaken: Card = -1;
  /** Card the player to move drew this turn, from either the stock or the pile (for display), else -1. */
  justDrew: Card = -1;
  /** known[p][c] = 1 if the opponent of p knows p holds card c (p picked it up from the pile). */
  known: [Uint8Array, Uint8Array] = [new Uint8Array(52), new Uint8Array(52)];
  /** Cards each player has discarded, in order. */
  discards: [Card[], Card[]] = [[], []];
  /** Top-of-pile cards each player declined (drew from stock or passed instead). */
  declined: [Card[], Card[]] = [[], []];
  /** Number of times each player has taken from the discard pile. */
  takes: [number, number] = [0, 0];
  turnsTaken = 0;
  result: HandResult | null = null;
  rules: Rules;

  constructor(rules: Rules) {
    this.rules = rules;
  }

  static deal(rules: Rules, dealer: number, rng: Rng): HandState {
    const deck = shuffle(fullDeck(), rng);
    return HandState.fromDeck(rules, dealer, deck);
  }

  /** deck: first 10 to non-dealer, next 10 to dealer, 21st is the upcard, rest is stock (drawn from the end). */
  static fromDeck(rules: Rules, dealer: number, deck: Card[]): HandState {
    const s = new HandState(rules);
    s.dealer = dealer;
    const nd = 1 - dealer;
    s.hands[nd] = deck.slice(0, 10);
    s.hands[dealer] = deck.slice(10, 20);
    s.upcard = deck[20];
    s.discard = [deck[20]];
    s.stock = deck.slice(21);
    s.turn = nd;
    s.opening = 0;
    s.phase = 'draw';
    s.setKnockLimit();
    return s;
  }

  setKnockLimit(): void {
    const r = this.rules;
    this.knockLimit = 10;
    this.multiplier = 1;
    if (r.oklahoma) {
      const rank = rankOf(this.upcard);
      this.knockLimit = rank === 0 && r.aceGinOnly ? 0 : VALUE[this.upcard];
      if (r.spadeDoubles && this.upcard < 13) this.multiplier = 2;
    }
  }

  clone(): HandState {
    const s = new HandState(this.rules);
    s.hands = [this.hands[0].slice(), this.hands[1].slice()];
    s.stock = this.stock.slice();
    s.discard = this.discard.slice();
    s.dealer = this.dealer;
    s.turn = this.turn;
    s.phase = this.phase;
    s.opening = this.opening;
    s.knockLimit = this.knockLimit;
    s.multiplier = this.multiplier;
    s.upcard = this.upcard;
    s.justTaken = this.justTaken;
    s.justDrew = this.justDrew;
    s.known = [this.known[0].slice(), this.known[1].slice()];
    s.discards = [this.discards[0].slice(), this.discards[1].slice()];
    s.declined = [this.declined[0].slice(), this.declined[1].slice()];
    s.takes = [this.takes[0], this.takes[1]];
    s.turnsTaken = this.turnsTaken;
    s.result = this.result;
    return s;
  }

  get topDiscard(): Card {
    return this.discard.length ? this.discard[this.discard.length - 1] : -1;
  }

  legalActions(): Action[] {
    if (this.phase === 'over') return [];
    const acts: Action[] = [];
    if (this.phase === 'draw') {
      if (this.opening <= 1) return [{ type: 'take' }, { type: 'pass' }];
      if (this.opening === 2) return [{ type: 'stock' }];
      if (this.discard.length) acts.push({ type: 'take' });
      acts.push({ type: 'stock' });
      return acts;
    }
    const hand = this.hands[this.turn];
    if (deadwood(hand) === 0) acts.push({ type: 'biggin' });
    for (const c of hand) {
      if (c === this.justTaken) continue;
      acts.push({ type: 'discard', card: c, knock: false });
      if (this.canKnockWith(c)) acts.push({ type: 'discard', card: c, knock: true });
    }
    return acts;
  }

  /** Deadwood after discarding `card` from the 11-card hand of the player to move. */
  deadwoodAfter(card: Card): number {
    const hand = this.hands[this.turn];
    return deadwood(hand.filter((c) => c !== card));
  }

  canKnockWith(card: Card): boolean {
    return this.deadwoodAfter(card) <= this.knockLimit;
  }

  apply(a: Action): void {
    if (this.phase === 'over') throw new Error('hand is over');
    const p = this.turn;
    const hand = this.hands[p];
    switch (a.type) {
      case 'pass': {
        if (this.phase !== 'draw' || this.opening > 1) throw new Error('illegal pass');
        this.declined[p].push(this.topDiscard);
        this.opening++;
        this.turn = 1 - p;
        return;
      }
      case 'take': {
        if (this.phase !== 'draw' || this.opening === 2 || !this.discard.length) throw new Error('illegal take');
        const c = this.discard.pop()!;
        hand.push(c);
        this.known[p][c] = 1;
        this.takes[p]++;
        this.justTaken = c;
        this.justDrew = c;
        this.opening = 3;
        this.phase = 'discard';
        return;
      }
      case 'stock': {
        if (this.phase !== 'draw' || this.opening <= 1) throw new Error('illegal stock draw');
        if (this.opening === 3 && this.discard.length) this.declined[p].push(this.topDiscard);
        hand.push(this.stock.pop()!);
        this.justTaken = -1;
        this.justDrew = hand[hand.length - 1];
        this.opening = 3;
        this.phase = 'discard';
        return;
      }
      case 'biggin': {
        if (this.phase !== 'discard' || deadwood(hand) !== 0) throw new Error('illegal big gin');
        this.finish(p, true);
        return;
      }
      case 'discard': {
        if (this.phase !== 'discard') throw new Error('illegal discard');
        const i = hand.indexOf(a.card);
        if (i < 0) throw new Error('card not in hand');
        if (a.card === this.justTaken) throw new Error('cannot discard the card just taken');
        if (a.knock && this.deadwoodAfter(a.card) > this.knockLimit) throw new Error('deadwood too high to knock');
        hand.splice(i, 1);
        this.known[p][a.card] = 0;
        this.discard.push(a.card);
        this.discards[p].push(a.card);
        this.justTaken = -1;
        this.justDrew = -1;
        this.turnsTaken++;
        if (a.knock) {
          this.finish(p, false);
          return;
        }
        if (this.stock.length <= this.rules.stockDrawAt) {
          this.phase = 'over';
          this.result = { kind: 'draw', winner: -1, points: 0, knocker: -1, knockerDeadwood: 0, defenderDeadwood: 0, laidOff: [] };
          return;
        }
        this.turn = 1 - p;
        this.phase = 'draw';
        return;
      }
    }
  }

  private finish(knocker: number, bigGin: boolean): void {
    this.phase = 'over';
    this.result = showdown(this.hands[knocker], this.hands[1 - knocker], knocker, bigGin, this.rules, this.multiplier);
  }
}

/** Score a hand that ended with a knock, gin, or big gin. */
export function showdown(knockerHand: readonly Card[], defenderHand: readonly Card[], knocker: number, bigGin: boolean, rules: Rules, multiplier = 1): HandResult {
  const ka = arrange(knockerHand);
  const gin = ka.deadwood === 0;
  let defDw: number;
  let laidOff: Card[] = [];
  let da: Arrangement;
  if (gin && !rules.layoffOnGin) {
    da = arrange(defenderHand);
    defDw = da.deadwood;
  } else {
    const lo = bestLayoff(defenderHand, ka.melds);
    defDw = lo.deadwood;
    laidOff = lo.laidOff;
    da = lo.arrangement;
  }
  const base = { knocker, knockerDeadwood: ka.deadwood, defenderDeadwood: defDw, knockerArrangement: ka, defenderArrangement: da, laidOff };
  if (bigGin) return { ...base, kind: 'biggin', winner: knocker, points: (rules.bigGinBonus + defDw) * multiplier };
  if (gin) return { ...base, kind: 'gin', winner: knocker, points: (rules.ginBonus + defDw) * multiplier };
  if (defDw <= ka.deadwood) return { ...base, kind: 'undercut', winner: 1 - knocker, points: (rules.undercutBonus + ka.deadwood - defDw) * multiplier };
  return { ...base, kind: 'knock', winner: knocker, points: (defDw - ka.deadwood) * multiplier };
}

/** Fast showdown value for simulations: points from the knocker's point of view (negative on undercut). */
export function showdownValue(knockerHand: readonly Card[], defenderHand: readonly Card[], bigGin: boolean, rules: Rules, multiplier: number): number {
  const kd = deadwood(knockerHand);
  if (kd === 0 && !rules.layoffOnGin) {
    return ((bigGin ? rules.bigGinBonus : rules.ginBonus) + deadwood(defenderHand)) * multiplier;
  }
  const r = showdown(knockerHand, defenderHand, 0, bigGin, rules, multiplier);
  return r.winner === 0 ? r.points : -r.points;
}
