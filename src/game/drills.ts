import { type Card, type Rng } from '../engine/cards';
import { type Action, type Rules, HandState } from '../engine/hand';
import { deadwood } from '../engine/melds';
import { type Models, makeLearned } from '../bots/learned';
import { type Analysis, type Category, type Verdict, analyze } from '../coach/analyze';

/** A whole hand position in a compact form that can be stored and reloaded. */
export interface SavedState {
  h: [Card[], Card[]];
  st: Card[];
  d: Card[];
  db: number[];
  dl: number;
  t: number;
  ph: 'draw' | 'discard' | 'over';
  op: number;
  up: Card;
  jt: Card;
  jd: Card;
  k: [Card[], Card[]];
  ds: [Card[], Card[]];
  dc: [Card[], Card[]];
  tk: [number, number];
  n: number;
}

const flags = (u: Uint8Array): Card[] => {
  const out: Card[] = [];
  for (let c = 0; c < 52; c++) if (u[c]) out.push(c);
  return out;
};

export function saveState(s: HandState): SavedState {
  return {
    h: [[...s.hands[0]], [...s.hands[1]]],
    st: [...s.stock],
    d: [...s.discard],
    db: [...s.discardBy],
    dl: s.dealer,
    t: s.turn,
    ph: s.phase,
    op: s.opening,
    up: s.upcard,
    jt: s.justTaken,
    jd: s.justDrew,
    k: [flags(s.known[0]), flags(s.known[1])],
    ds: [[...s.discards[0]], [...s.discards[1]]],
    dc: [[...s.declined[0]], [...s.declined[1]]],
    tk: [s.takes[0], s.takes[1]],
    n: s.turnsTaken,
  };
}

export function loadState(o: SavedState, rules: Rules): HandState {
  const s = new HandState(rules);
  s.hands = [[...o.h[0]], [...o.h[1]]];
  s.stock = [...o.st];
  s.discard = [...o.d];
  s.discardBy = [...o.db];
  s.dealer = o.dl;
  s.turn = o.t;
  s.phase = o.ph;
  s.opening = o.op;
  s.upcard = o.up;
  s.setKnockLimit();
  s.justTaken = o.jt;
  s.justDrew = o.jd;
  for (const c of o.k[0]) s.known[0][c] = 1;
  for (const c of o.k[1]) s.known[1][c] = 1;
  s.discards = [[...o.ds[0]], [...o.ds[1]]];
  s.declined = [[...o.dc[0]], [...o.dc[1]]];
  s.takes = [o.tk[0], o.tk[1]];
  s.turnsTaken = o.n;
  return s;
}

/** A flagged mistake from your own play, kept so it can be replayed as a drill. */
export interface SavedMistake {
  id: string;
  ts: number;
  category: Category | null;
  loss: number;
  state: SavedState;
  played: string;
}

export type DrillKind = 'knock' | 'discard' | 'draw';
export const DRILL_LABEL: Record<DrillKind, string> = {
  knock: 'Knock or play on',
  discard: 'Choose the discard',
  draw: 'Take the pile card or draw',
};

/** Which drill a category of mistake calls for. */
export function drillForCategory(c: Category): DrillKind {
  if (c === 'pile') return 'draw';
  if (c === 'knock-early' || c === 'knock-late') return 'knock';
  return 'discard';
}

const isKnock = (a: Action) => a.type === 'biggin' || (a.type === 'discard' && a.knock);

/** Does this position make a good drill of the given kind? (A real choice with a clear answer.) */
export function suitsDrill(s: HandState, an: Analysis, kind: DrillKind): boolean {
  if (an.forced || an.options.length < 2) return false;
  const best = an.options[0];
  if (kind === 'draw') {
    if (s.phase !== 'draw' || s.opening !== 3) return false;
    return best.ev - an.options[1].ev >= 3;
  }
  if (s.phase !== 'discard' || best.nominal) return false;
  const knock = an.options.find((o) => isKnock(o.action));
  const wait = an.options.find((o) => !isKnock(o.action));
  if (kind === 'knock') return !!knock && !!wait && !knock.nominal && Math.abs(knock.ev - wait.ev) >= 1.5;
  if (knock) return false;
  // a discard drill needs several clearly worse choices, so there is something to find
  const mid = an.options[Math.min(an.options.length - 1, 4)];
  return best.ev - mid.ev >= 2.5 && deadwood(s.hands[s.turn]) > 0;
}

/** Deal and play bot hands until a position of the wanted kind turns up. You are the player to move. */
export function generateDrill(kind: DrillKind, rules: Rules, m: Models, rng: Rng): HandState | null {
  const bot = makeLearned(m, { members: 1 });
  for (let hands = 0; hands < 80; hands++) {
    const s = HandState.deal(rules, rng() < 0.5 ? 0 : 1, rng);
    // skip a random number of the wanted decisions so drills come from every stage of a hand
    let skip = (rng() * 4) | 0;
    let guard = 0;
    while (s.phase !== 'over' && guard++ < 300) {
      const wanted = kind === 'draw' ? s.phase === 'draw' && s.opening === 3 : s.phase === 'discard';
      if (wanted && (kind !== 'draw' || rng() < 0.35)) {
        const an = analyze(s, m);
        if (suitsDrill(s, an, kind)) {
          if (skip-- <= 0) return s.clone();
        }
      }
      s.apply(bot.act(s, rng));
    }
  }
  return null;
}

/** Was the drill answered well? The best play, or one the coach cannot separate from it. */
export const drillCorrect = (v: Verdict): boolean => v.chosen === v.best || (!v.flagged && v.loss <= Math.max(1, v.margin));
