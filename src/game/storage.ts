import { HOUSE_RULES, type Rules } from '../engine/hand';
import type { BotLevel, DecisionRecord, HandSummary } from './session';

export interface Settings {
  level: BotLevel;
  /** when the coach speaks: after each move, after the hand, or never */
  feedback: 'move' | 'hand' | 'off';
  useMatchScore: boolean;
  showSeenCards: boolean;
  /** keep the hand in the order you arrange it instead of sorting it into melds */
  manualArrange: boolean;
  /** the coach rates each option before you commit */
  explore: boolean;
  /** pause after a flagged mistake so the play can be taken back */
  takeBack: boolean;
  rules: Rules;
}

export const DEFAULT_SETTINGS: Settings = { level: 'strong', feedback: 'move', useMatchScore: true, showSeenCards: true, manualArrange: false, explore: false, takeBack: true, rules: HOUSE_RULES };

const K = { settings: 'gc.settings.v1', hands: 'gc.hands.v1', records: 'gc.records.v1' };

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: the app still works for this session */
  }
}

export const loadSettings = (): Settings => {
  const s = read<Partial<Settings>>(K.settings, {});
  // the table rules are fixed in the app (the coach is trained on them), so stored copies are ignored
  return { ...DEFAULT_SETTINGS, ...s, rules: HOUSE_RULES };
};
export const saveSettings = (s: Settings): void => write(K.settings, s);

export const loadHands = (): HandSummary[] => read<HandSummary[]>(K.hands, []);
export interface StoredHand {
  id: string;
  records: DecisionRecord[];
}
export const loadRecords = (): StoredHand[] => read<StoredHand[]>(K.records, []);

export function saveHand(summary: HandSummary, records: DecisionRecord[]): void {
  const hands = loadHands();
  if (hands.some((h) => h.id === summary.id)) return;
  hands.push(summary);
  write(K.hands, hands.slice(-3000));
  const recs = loadRecords();
  recs.push({ id: summary.id, records });
  write(K.records, recs.slice(-25));
}

export function clearHistory(): void {
  write(K.hands, []);
  write(K.records, []);
}
