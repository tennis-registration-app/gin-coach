import { type Card, type Rng, cardName, makeRng } from '../engine/cards';
import { type Action, type HandResult, type Rules, HandState } from '../engine/hand';
import { arrange } from '../engine/melds';
import { heuristicPolicy, playHand, simplePolicy, type Policy } from '../bots/policy';
import { type Models, makeLearned } from '../bots/learned';
import { type Analysis, type Category, type MatchContext, type Verdict, actionLabel, analyze, judge } from '../coach/analyze';
import { hindsight } from '../coach/facts';

export type BotLevel = 'easy' | 'medium' | 'strong' | 'expert';
export const LEVEL_LABEL: Record<BotLevel, string> = {
  easy: 'Easy (knocks as soon as it can)',
  medium: 'Medium (rule-based)',
  strong: 'Strong (trained by self-play)',
  expert: 'Expert (trained, looks a draw ahead)',
};

export const ME = 0;
export const OPP = 1;

export interface DecisionRecord {
  idx: number;
  kind: 'draw' | 'discard';
  /** what happened since your previous decision */
  events: string[];
  myHand: Card[];
  oppHand: Card[];
  pile: Card[];
  stock: number;
  knockLimit: number;
  options: { label: string; ev: number }[];
  chosen: string;
  best: string;
  loss: number;
  margin: number;
  flagged: boolean;
  tooClose: boolean;
  category: Category | null;
  headline: string;
  reasons: string[];
  /** the checks behind the verdict, and the play they compare yours against */
  why?: { title: string; lines: string[] }[];
  versus?: string;
  /** what the hidden cards showed; only displayed once the hand is over */
  hindsight?: string[];
  /** you took this play back and tried again (it still counts in your statistics) */
  retried?: boolean;
  /** this was a second attempt after taking a play back (not counted in your statistics) */
  retry?: boolean;
}

export interface HandSummary {
  id: string;
  ts: number;
  level: BotLevel;
  /** points for you in your own matchup (negative if the opponent scored) */
  myPoints: number;
  kind: HandResult['kind'];
  decisions: number;
  flagged: number;
  /** flagged expected-point losses by category */
  lossByCat: Partial<Record<Category, number>>;
  /** all estimated losses, flagged or not */
  totalLoss: number;
  /** the coach rated options before you chose at least once in this hand */
  aided?: boolean;
}

export interface RoundResult {
  mine: HandResult;
  partner: HandResult;
  /** points added to each team this round */
  usDelta: number;
  themDelta: number;
}

export interface GameState {
  us: number;
  them: number;
  handNo: number;
  partner: string;
  oppA: string;
  oppB: string;
  over: boolean;
  rounds: { us: number; them: number }[];
  iDeal: boolean;
}

const NAMES = ['Walker', 'Beau', 'Margot', 'Henri', 'Celeste', 'Tommy', 'Lucille', 'Remy', 'Odette', 'Gus'];

export function makeBot(level: BotLevel, m: Models): Policy {
  if (level === 'easy') return simplePolicy;
  if (level === 'medium') return heuristicPolicy;
  return makeLearned(m, { lookahead: level === 'expert', members: 1 });
}

export class Session {
  rules: Rules;
  models: Models;
  level: BotLevel;
  rng: Rng;
  game!: GameState;
  hand!: HandState;
  bot!: Policy;
  /** partner's matchup, played out in advance and revealed as your hand progresses */
  partnerResult!: HandResult;
  partnerTurns = 0;
  events: string[] = [];
  log: string[] = [];
  records: DecisionRecord[] = [];
  analysis: Analysis | null = null;
  lastVerdict: Verdict | null = null;
  round: RoundResult | null = null;
  useMatchScore = true;
  handId = '';
  /** true once the coach has rated options for you before a choice in this hand */
  aided = false;
  /** when set, the opponent waits after a flagged mistake so you can take it back */
  pauseOnMistake = false;
  awaiting = false;
  private undo: { hand: HandState; events: string[]; logLen: number; wasStock: boolean } | null = null;
  private retrying = false;
  /** your own left-to-right arrangement of your hand (used when arranging by hand) */
  order: Card[] = [];

  constructor(rules: Rules, models: Models, level: BotLevel, seed = (Date.now() ^ (Math.random() * 2 ** 31)) >>> 0) {
    this.rules = rules;
    this.models = models;
    this.level = level;
    this.rng = makeRng(seed);
    this.newGame();
  }

  newGame(): void {
    // draw for partners: shuffle the three other players
    const pool = [...NAMES];
    const picks: string[] = [];
    for (let i = 0; i < 3; i++) picks.push(pool.splice((this.rng() * pool.length) | 0, 1)[0]);
    this.game = { us: 0, them: 0, handNo: 0, partner: picks[0], oppA: picks[1], oppB: picks[2], over: false, rounds: [], iDeal: this.rng() < 0.5 };
    this.startHand();
  }

  get opponentName(): string {
    return this.game.handNo % 2 === 1 ? this.game.oppA : this.game.oppB;
  }
  get partnerOpponentName(): string {
    return this.game.handNo % 2 === 1 ? this.game.oppB : this.game.oppA;
  }

  startHand(): void {
    const g = this.game;
    g.handNo++;
    this.bot = makeBot(this.level, this.models);
    this.hand = HandState.deal(this.rules, g.iDeal ? ME : OPP, this.rng);
    // partner's table: partner is seat 0 there
    const pb = makeLearned(this.models, { members: 1 });
    const ps = playHand(HandState.deal(this.rules, this.rng() < 0.5 ? 0 : 1, this.rng), [pb, makeBot(this.level, this.models)], this.rng);
    this.partnerResult = ps.result!;
    this.partnerTurns = ps.turnsTaken;
    this.events = [];
    this.log = [`Hand ${g.handNo}. The upcard is the ${cardName(this.hand.upcard)}: ${this.hand.knockLimit === 0 ? 'gin only this hand' : `knock with ${this.hand.knockLimit} or less`}.`];
    this.records = [];
    this.round = null;
    this.lastVerdict = null;
    this.handId = `${Date.now()}-${g.handNo}`;
    this.order = [];
    this.aided = false;
    this.awaiting = false;
    this.undo = null;
    this.retrying = false;
    this.refreshAnalysis();
  }

  /** Is the partner's result known to you yet? */
  get partnerKnown(): boolean {
    return this.hand.phase === 'over' || this.hand.turnsTaken >= this.partnerTurns;
  }

  /** Partner's result as points for our team (negative if their opponent scored). */
  get partnerDelta(): number {
    const r = this.partnerResult;
    return r.winner < 0 ? 0 : r.winner === 0 ? r.points : -r.points;
  }

  matchContext(): MatchContext {
    return { us: this.game.us, them: this.game.them, partnerDelta: this.partnerKnown ? this.partnerDelta : null, target: this.rules.target };
  }

  /** Your hand in your own order: cards you still hold keep their place, new cards go on the right. */
  myOrder(): Card[] {
    const hand = this.hand.hands[ME];
    if (this.order.length === 0) {
      const a = arrange(hand);
      this.order = [...a.melds.flat(), ...a.deadwoodCards];
    }
    const kept = this.order.filter((c) => hand.includes(c));
    this.order = [...kept, ...hand.filter((c) => !kept.includes(c))];
    return this.order;
  }

  /** Move a card one place left (-1) or right (+1) in your arrangement. */
  moveCard(card: Card, dir: -1 | 1): void {
    const o = this.myOrder();
    const i = o.indexOf(card);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= o.length) return;
    [o[i], o[j]] = [o[j], o[i]];
  }

  /** Re-sort your arrangement into melds and deadwood. */
  sortHand(): void {
    this.order = [];
    this.myOrder();
  }

  get myTurn(): boolean {
    return this.hand.phase !== 'over' && this.hand.turn === ME;
  }

  private refreshAnalysis(): void {
    this.analysis = this.myTurn ? analyze(this.hand, this.models, this.matchContext()) : null;
  }

  private note(text: string): void {
    this.events.push(text);
    this.log.push(text);
  }

  /** Apply your action. Returns the coach's verdict on it. */
  act(a: Action): Verdict {
    if (!this.myTurn) throw new Error('not your turn');
    const s = this.hand;
    const an = this.analysis ?? analyze(s, this.models, this.matchContext());
    const v = judge(s, an, a, this.useMatchScore);
    this.undo = { hand: s.clone(), events: [...this.events], logLen: this.log.length, wasStock: a.type === 'stock' };
    this.records.push({
      idx: this.records.length,
      kind: an.kind,
      events: this.events,
      myHand: [...s.hands[ME]],
      oppHand: [...s.hands[OPP]],
      pile: [...s.discard],
      stock: s.stock.length,
      knockLimit: s.knockLimit,
      options: an.options.slice(0, 6).map((o) => ({ label: o.label, ev: o.ev })),
      chosen: v.chosen.label,
      best: v.best.label,
      loss: v.loss,
      margin: v.margin,
      flagged: v.flagged,
      tooClose: v.tooClose,
      category: v.category,
      headline: v.headline,
      reasons: v.reasons,
      why: v.why,
      versus: v.versus,
      hindsight: this.hindsightFor(a, v),
      retry: this.retrying || undefined,
    });
    this.retrying = false;
    this.events = [];
    const label = actionLabel(a, s);
    this.log.push(`You: ${label[0].toLowerCase()}${label.slice(1)}.`);
    s.apply(a);
    this.lastVerdict = v;
    if (s.phase === 'over') this.undo = null; // hidden cards are now showing
    this.awaiting = this.pauseOnMistake && v.flagged && s.phase !== 'over';
    this.afterMove();
    return v;
  }

  /** The coach's rating of an action you have not made yet. Marks the hand as aided. */
  preview(a: Action): Verdict {
    const an = this.analysis ?? analyze(this.hand, this.models, this.matchContext());
    this.aided = true;
    return judge(this.hand, an, a, this.useMatchScore);
  }

  /** Can your last play be taken back? Only until the opponent has acted, and never once the hand is over. */
  get canTakeBack(): boolean {
    return this.undo !== null && this.hand.phase !== 'over';
  }

  /** Return to the decision you just made. The first attempt stays in your statistics. */
  takeBack(): void {
    if (!this.canTakeBack || !this.undo) return;
    const u = this.undo;
    this.hand = u.hand;
    // a stock draw showed you a hidden card: reshuffle the stock so it cannot be used
    if (u.wasStock) {
      const st = this.hand.stock;
      for (let i = st.length - 1; i > 0; i--) {
        const j = (this.rng() * (i + 1)) | 0;
        [st[i], st[j]] = [st[j], st[i]];
      }
    }
    this.events = u.events;
    this.log.length = u.logLen;
    this.log.push('You took that play back.');
    const last = this.records[this.records.length - 1];
    if (last) last.retried = true;
    this.retrying = true;
    this.undo = null;
    this.awaiting = false;
    this.lastVerdict = null;
    this.refreshAnalysis();
  }

  /** Keep the play you made and let the opponent move. */
  keepPlay(): void {
    this.awaiting = false;
    this.undo = null;
  }

  private hindsightFor(a: Action, v: Verdict): string[] {
    if (a.type !== 'discard' || a.knock) return [];
    const opp = this.hand.hands[OPP];
    const out = [hindsight(opp, a.card)];
    const b = v.best.action;
    if (b.type === 'discard' && !b.knock && b.card !== a.card) out.push(hindsight(opp, b.card));
    return out;
  }

  /** Let the opponent make one action. Returns false if it is not their turn. */
  stepOpponent(): boolean {
    const s = this.hand;
    if (s.phase === 'over' || s.turn !== OPP || this.awaiting) return false;
    this.undo = null;
    const a = this.bot.act(s, this.rng);
    const who = this.opponentName;
    switch (a.type) {
      case 'take':
        this.note(`${who} took the ${cardName(s.topDiscard)} from the pile.`);
        break;
      case 'pass':
        this.note(`${who} passed on the upcard.`);
        break;
      case 'stock':
        this.note(`${who} drew from the stock.`);
        break;
      case 'biggin':
        this.note(`${who} declared eleven-card gin.`);
        break;
      case 'discard':
        this.note(a.knock ? `${who} discarded the ${cardName(a.card)} and knocked.` : `${who} discarded the ${cardName(a.card)}.`);
        break;
    }
    s.apply(a);
    this.afterMove();
    return true;
  }

  private afterMove(): void {
    if (this.hand.phase === 'over') this.finishRound();
    else this.refreshAnalysis();
  }

  private finishRound(): void {
    const mine = this.hand.result!;
    const myPts = mine.winner < 0 ? 0 : mine.winner === ME ? mine.points : -mine.points;
    const pd = this.partnerDelta;
    const usDelta = Math.max(myPts, 0) + Math.max(pd, 0);
    const themDelta = Math.max(-myPts, 0) + Math.max(-pd, 0);
    const g = this.game;
    g.us += usDelta;
    g.them += themDelta;
    g.rounds.push({ us: usDelta, them: themDelta });
    if (g.us >= this.rules.target || g.them >= this.rules.target) g.over = true;
    // winner of your matchup deals the next hand; after a draw the same dealer deals again
    if (mine.winner >= 0) g.iDeal = mine.winner === ME;
    this.round = { mine, partner: this.partnerResult, usDelta, themDelta };
    this.analysis = null;
  }

  summary(): HandSummary {
    const mine = this.hand.result!;
    const lossByCat: Partial<Record<Category, number>> = {};
    let flagged = 0;
    let total = 0;
    const counted = this.records.filter((r) => !r.retry);
    for (const r of counted) {
      total += r.loss;
      if (r.flagged && r.category) {
        flagged++;
        lossByCat[r.category] = (lossByCat[r.category] ?? 0) + r.loss;
      }
    }
    return {
      id: this.handId,
      ts: Date.now(),
      level: this.level,
      myPoints: mine.winner < 0 ? 0 : mine.winner === ME ? mine.points : -mine.points,
      kind: mine.kind,
      decisions: counted.length,
      flagged,
      lossByCat,
      totalLoss: total,
      aided: this.aided || undefined,
    };
  }
}
