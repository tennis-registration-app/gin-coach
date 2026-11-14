import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { type Card, RANKS, SUITS, cardName, suitOf, rankOf } from './engine/cards';
import { type Action, type HandResult } from './engine/hand';
import { arrange, deadwood } from './engine/melds';
import { loadModels } from './bots/learned';
import { CATEGORY_LABEL, type Category } from './coach/analyze';
import type { ModelFile } from './coach/model';
import modelJson from './coach/model.json';
import { LEVEL_LABEL, ME, OPP, Session, type BotLevel, type DecisionRecord, type HandSummary } from './game/session';
import { clearHistory, loadHands, loadRecords, loadSettings, saveHand, saveSettings, type Settings } from './game/storage';

const models = loadModels(modelJson as unknown as ModelFile);

type Tab = 'play' | 'review' | 'progress' | 'rules';

function CardView({ card, selected, onClick, small, dim, tag }: { card: Card; selected?: boolean; onClick?: () => void; small?: boolean; dim?: boolean; tag?: string }) {
  const red = suitOf(card) === 1 || suitOf(card) === 2;
  const cls = `card${red ? ' red' : ''}${selected ? ' selected' : ''}${small ? ' small' : ''}${dim ? ' dim' : ''}${onClick ? ' tappable' : ''}`;
  const inner = (
    <>
      <span className="rank">{RANKS[rankOf(card)]}</span>
      <span className="suit">{SUITS[suitOf(card)]}</span>
      {tag && <span className="tag">{tag}</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} aria-label={cardName(card)} aria-pressed={selected}>
      {inner}
    </button>
  ) : (
    <span className={cls} aria-label={cardName(card)}>
      {inner}
    </span>
  );
}

const CardBack = ({ small }: { small?: boolean }) => <span className={`card back${small ? ' small' : ''}`} aria-hidden="true" />;

/** A hand laid out as melds then deadwood. */
function Spread({ cards, small, laidOff }: { cards: Card[]; small?: boolean; laidOff?: Card[] }) {
  const a = arrange(cards);
  return (
    <div className="spread">
      {a.melds.map((m, i) => (
        <div className="group meld" key={i}>
          {m.map((c) => (
            <CardView key={c} card={c} small={small} />
          ))}
        </div>
      ))}
      {a.deadwoodCards.length > 0 && (
        <div className="group">
          {a.deadwoodCards.map((c) => (
            <CardView key={c} card={c} small={small} />
          ))}
        </div>
      )}
      {laidOff && laidOff.length > 0 && (
        <div className="group laidoff">
          {laidOff.map((c) => (
            <CardView key={c} card={c} small={small} tag="laid off" />
          ))}
        </div>
      )}
    </div>
  );
}

const signed = (x: number, digits = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(digits);

function describeResult(r: HandResult, winnerName: string, loserName: string): string {
  switch (r.kind) {
    case 'draw':
      return 'The stock ran down to two cards. No score.';
    case 'gin':
      return `${winnerName} went gin: 25 + ${r.defenderDeadwood} = ${r.points}.`;
    case 'biggin':
      return `${winnerName} made eleven-card gin: 50 + ${r.defenderDeadwood} = ${r.points}.`;
    case 'undercut':
      return `${loserName} knocked with ${r.knockerDeadwood} and was undercut (${r.defenderDeadwood}): 10 + ${r.knockerDeadwood - r.defenderDeadwood} = ${r.points} to ${winnerName}.`;
    case 'knock':
      return `${winnerName} knocked with ${r.knockerDeadwood} against ${r.defenderDeadwood}: ${r.points}.`;
  }
}

function CoachCard({ rec, showNumbers }: { rec: DecisionRecord; showNumbers?: boolean }) {
  const [open, setOpen] = useState(!!showNumbers);
  const tone = rec.flagged ? 'bad' : rec.tooClose ? 'close' : 'good';
  return (
    <div className={`coach ${tone}`}>
      <p className="headline">{rec.headline}</p>
      {rec.reasons.map((r, i) => (
        <p key={i}>{r}</p>
      ))}
      <button type="button" className="link" onClick={() => setOpen(!open)}>
        {open ? 'Hide the numbers' : 'Show the numbers'}
      </button>
      {open && (
        <table className="numbers">
          <thead>
            <tr>
              <th>Option</th>
              <th>Expected points</th>
            </tr>
          </thead>
          <tbody>
            {rec.options.map((o) => (
              <tr key={o.label} className={o.label === rec.chosen ? 'chosen' : ''}>
                <td>
                  {o.label}
                  {o.label === rec.chosen ? ' (your play)' : ''}
                </td>
                <td>{signed(o.ev)}</td>
              </tr>
            ))}
            {!rec.options.some((o) => o.label === rec.chosen) && (
              <tr className="chosen">
                <td>{rec.chosen} (your play)</td>
                <td>{signed(rec.options[0].ev - rec.loss)}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Play({ session, settings, bump }: { session: Session; settings: Settings; bump: () => void }) {
  const s = session.hand;
  const g = session.game;
  const [sel, setSel] = useState<Card | null>(null);
  const [hint, setHint] = useState(false);
  const saved = useRef('');
  const over = s.phase === 'over';
  const myTurn = session.myTurn;

  // opponent moves on a short delay so you can follow them
  useEffect(() => {
    if (over || myTurn) return;
    const t = setTimeout(() => {
      session.stepOpponent();
      bump();
    }, 750);
    return () => clearTimeout(t);
  });

  useEffect(() => {
    if (over && saved.current !== session.handId) {
      saved.current = session.handId;
      saveHand(session.summary(), session.records);
    }
  });

  const act = (a: Action) => {
    session.useMatchScore = settings.useMatchScore;
    session.act(a);
    setSel(null);
    setHint(false);
    bump();
  };

  const hand = s.hands[ME];
  const arr = useMemo(() => arrange(hand), [hand.join(',')]); // eslint-disable-line
  const dw = arr.deadwood;
  const top = s.topDiscard;
  const lastRec = session.records[session.records.length - 1];
  const showCoach = settings.feedback === 'move' && lastRec;
  const selDw = sel !== null && s.phase === 'discard' && myTurn ? deadwood(hand.filter((c) => c !== sel)) : null;
  const canDiscardSel = sel !== null && sel !== s.justTaken;
  const bigGin = myTurn && s.phase === 'discard' && dw === 0;
  const oppName = session.opponentName;
  const seen: Card[] = [];
  if (settings.showSeenCards) for (let c = 0; c < 52; c++) if (s.known[OPP][c]) seen.push(c);

  let prompt = '';
  if (over) prompt = '';
  else if (!myTurn) prompt = `${oppName} is thinking…`;
  else if (s.phase === 'draw') prompt = s.opening <= 1 ? `Take the upcard or pass?` : s.opening === 2 ? 'Both passed. Draw from the stock.' : 'Draw from the stock or take the top discard.';
  else prompt = sel === null ? 'Tap a card to discard.' : '';

  const partnerLine = session.partnerKnown
    ? `${g.partner} v ${session.partnerOpponentName}: ${describeResult(session.partnerResult, session.partnerResult.winner === 0 ? g.partner : session.partnerOpponentName, session.partnerResult.winner === 0 ? session.partnerOpponentName : g.partner)}`
    : `${g.partner} v ${session.partnerOpponentName}: still playing`;

  const hintText = hint && session.analysis ? session.analysis.options[0].label : null;

  return (
    <div className="play">
      <header className="scorebar">
        <div className="team">
          <span className="who">You &amp; {g.partner}</span>
          <span className="score">{g.us}</span>
        </div>
        <div className="mid">
          <span>Hand {g.handNo}</span>
          <span>to {session.rules.target}</span>
        </div>
        <div className="team right">
          <span className="who">
            {g.oppA} &amp; {g.oppB}
          </span>
          <span className="score">{g.them}</span>
        </div>
      </header>
      <p className="partner">{partnerLine}</p>

      <section className="felt">
        <div className="opp">
          <span className="name">{oppName}</span>
          <div className="backs">
            {over
              ? null
              : Array.from({ length: Math.max(0, s.hands[OPP].length - seen.length) }, (_, i) => <CardBack key={i} small />)}
            {!over && seen.map((c) => <CardView key={c} card={c} small tag="seen" />)}
          </div>
          {over && <Spread cards={s.hands[OPP]} small laidOff={s.result && s.result.knocker === ME ? s.result.laidOff : undefined} />}
        </div>

        <div className="center">
          <div className="pilewrap">
            <button type="button" className="stock" disabled={!myTurn || s.phase !== 'draw' || s.opening <= 1} onClick={() => act({ type: 'stock' })} aria-label="Draw from the stock">
              <CardBack />
              <span className="count">{s.stock.length} in stock</span>
            </button>
            <div className="discard">
              {top >= 0 ? (
                <CardView card={top} onClick={myTurn && s.phase === 'draw' && s.opening !== 2 ? () => act({ type: 'take' }) : undefined} />
              ) : (
                <span className="card empty" />
              )}
              <span className="count">{top >= 0 ? 'top discard' : 'pile empty'}</span>
            </div>
          </div>
          <div className={`limit${s.knockLimit === 0 ? ' ginonly' : ''}`}>
            {s.knockLimit === 0 ? 'Gin only' : `Knock at ${s.knockLimit} or less`}
            <span className="sub">upcard {cardName(s.upcard)}</span>
          </div>
        </div>

        <div className="me">
          <div className="handrow">
            {arr.melds.map((m, i) => (
              <div className="group meld" key={i}>
                {m.map((c) => (
                  <CardView key={c} card={c} selected={sel === c} dim={c === s.justTaken && s.phase === 'discard'} onClick={myTurn && s.phase === 'discard' ? () => setSel(sel === c ? null : c) : undefined} />
                ))}
              </div>
            ))}
            <div className="group">
              {arr.deadwoodCards.map((c) => (
                <CardView key={c} card={c} selected={sel === c} dim={c === s.justTaken && s.phase === 'discard'} onClick={myTurn && s.phase === 'discard' ? () => setSel(sel === c ? null : c) : undefined} />
              ))}
            </div>
          </div>
          <p className="deadwood">
            Deadwood {dw}
            {selDw !== null && sel !== null ? `, ${selDw} after discarding the ${cardName(sel)}` : ''}
          </p>
        </div>

        <div className="actions" aria-live="polite">
          {prompt && <span className="prompt">{prompt}</span>}
          {myTurn && s.phase === 'draw' && s.opening <= 1 && (
            <>
              <button type="button" className="btn primary" onClick={() => act({ type: 'take' })}>
                Take the {cardName(top)}
              </button>
              <button type="button" className="btn" onClick={() => act({ type: 'pass' })}>
                Pass
              </button>
            </>
          )}
          {bigGin && (
            <button type="button" className="btn primary" onClick={() => act({ type: 'biggin' })}>
              Declare eleven-card gin
            </button>
          )}
          {myTurn && s.phase === 'discard' && sel !== null && (
            <>
              {!canDiscardSel && <span className="prompt">You can’t discard the card you just took.</span>}
              {canDiscardSel && (
                <button type="button" className="btn" onClick={() => act({ type: 'discard', card: sel, knock: false })}>
                  Discard the {cardName(sel)}
                </button>
              )}
              {canDiscardSel && selDw !== null && selDw <= s.knockLimit && (
                <button type="button" className="btn primary" onClick={() => act({ type: 'discard', card: sel, knock: true })}>
                  {selDw === 0 ? 'Go gin' : `Knock with ${selDw}`}
                </button>
              )}
            </>
          )}
          {myTurn && settings.feedback !== 'off' && !hint && (
            <button type="button" className="link light" onClick={() => setHint(true)}>
              Ask the coach first
            </button>
          )}
          {hintText && <span className="prompt hint">Coach would: {hintText.toLowerCase()}.</span>}
        </div>
      </section>

      {over && session.round && (
        <section className="result">
          <h2>{describeResult(s.result!, s.result!.winner === ME ? 'You' : oppName, s.result!.winner === ME ? oppName : 'You')}</h2>
          <p>{partnerLine}</p>
          <p className="totals">
            This round: you and {g.partner} {session.round.usDelta}, {g.oppA} and {g.oppB} {session.round.themDelta}. Game score {g.us} to {g.them}.
          </p>
          {settings.feedback !== 'off' && (
            <p>
              Coach: {session.records.filter((r) => r.flagged).length} mistake{session.records.filter((r) => r.flagged).length === 1 ? '' : 's'} flagged in {session.records.length} decisions, about{' '}
              {session.records.filter((r) => r.flagged).reduce((a, r) => a + r.loss, 0).toFixed(1)} points. See Review for the full replay.
            </p>
          )}
          {g.over ? (
            <>
              <h2>{g.us > g.them ? `You and ${g.partner} win the game.` : g.us < g.them ? `${g.oppA} and ${g.oppB} win the game.` : 'The game is tied.'}</h2>
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  session.newGame();
                  bump();
                }}
              >
                Draw for partners and start a new game
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                session.startHand();
                bump();
              }}
            >
              Deal the next hand
            </button>
          )}
        </section>
      )}

      {showCoach && <CoachCard key={`${session.handId}-${lastRec.idx}`} rec={lastRec} />}

      <details className="log">
        <summary>Hand log</summary>
        <ol>
          {session.log.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      </details>
    </div>
  );
}

function Review({ session }: { session: Session }) {
  const stored = useMemo(() => loadRecords(), [session.handId, session.hand.phase]); // eslint-disable-line
  const live = session.hand.phase === 'over' || !stored.length;
  const [which, setWhich] = useState(0); // 0 = most recent
  const list = live ? [{ id: session.handId, records: session.records }, ...stored.filter((h) => h.id !== session.handId).reverse()] : [...stored].reverse();
  const handRec = list[Math.min(which, list.length - 1)];
  const [i, setI] = useState(0);
  const recs = handRec?.records ?? [];
  const rec = recs[Math.min(i, recs.length - 1)];
  if (!rec) return <p className="empty">Play a hand and your decisions will appear here, with every hidden card revealed.</p>;
  const inProgress = handRec.id === session.handId && session.hand.phase !== 'over';
  return (
    <div className="review">
      <div className="row">
        <label>
          Hand{' '}
          <select
            value={which}
            onChange={(e) => {
              setWhich(+e.target.value);
              setI(0);
            }}
          >
            {list.map((h, k) => (
              <option key={h.id} value={k}>
                {k === 0 ? 'Most recent' : `${k} back`} ({h.records.filter((r) => r.flagged).length} flagged)
              </option>
            ))}
          </select>
        </label>
      </div>
      <ol className="steps">
        {recs.map((r, k) => (
          <li key={k}>
            <button type="button" className={`step${k === i ? ' on' : ''}${r.flagged ? ' bad' : r.tooClose ? ' close' : ''}`} onClick={() => setI(k)} aria-label={`Decision ${k + 1}${r.flagged ? ', mistake' : ''}`}>
              {k + 1}
            </button>
          </li>
        ))}
      </ol>
      <section className="felt replay">
        <p className="replay-meta">
          Decision {i + 1} of {recs.length}: {rec.kind === 'draw' ? 'draw' : 'discard'}. {rec.knockLimit === 0 ? 'Gin only' : `Knock limit ${rec.knockLimit}`}, {rec.stock} cards in stock.
        </p>
        {rec.events.length > 0 && <p className="replay-meta">{rec.events.join(' ')}</p>}
        <div className="opp">
          <span className="name">Opponent’s hand{inProgress ? ' (hidden until the hand ends)' : ''}</span>
          {!inProgress && <Spread cards={rec.oppHand} small />}
        </div>
        <div className="center">
          <div className="discard">
            {rec.pile.length ? <CardView card={rec.pile[rec.pile.length - 1]} /> : <span className="card empty" />}
            <span className="count">top discard</span>
          </div>
        </div>
        <div className="me">
          <span className="name">Your hand</span>
          <Spread cards={rec.myHand} />
        </div>
        <p className="replay-meta">You chose: {rec.chosen.toLowerCase()}.</p>
      </section>
      <CoachCard key={`${handRec.id}-${i}`} rec={rec} showNumbers />
      <div className="row">
        <button type="button" className="btn" disabled={i === 0} onClick={() => setI(i - 1)}>
          Previous
        </button>
        <button type="button" className="btn" disabled={i >= recs.length - 1} onClick={() => setI(i + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}

const CATS = Object.keys(CATEGORY_LABEL) as Category[];

function leakPerHand(hands: HandSummary[]): Record<Category, number> {
  const out = Object.fromEntries(CATS.map((c) => [c, 0])) as Record<Category, number>;
  for (const h of hands) for (const c of CATS) out[c] += h.lossByCat[c] ?? 0;
  for (const c of CATS) out[c] = hands.length ? out[c] / hands.length : 0;
  return out;
}

function Progress({ version }: { version: number }) {
  const hands = useMemo(() => loadHands(), [version]); // eslint-disable-line
  if (hands.length === 0) return <p className="empty">No hands yet. After a few dozen hands this page shows which kinds of mistakes cost you the most points.</p>;
  const recent = hands.slice(-25);
  const earlier = hands.slice(0, -25);
  const all = leakPerHand(hands);
  const rec = leakPerHand(recent);
  const old = leakPerHand(earlier);
  const total = (r: Record<Category, number>) => CATS.reduce((a, c) => a + r[c], 0);
  const max = Math.max(0.5, ...CATS.map((c) => Math.max(all[c], rec[c])));
  const sorted = [...CATS].sort((a, b) => all[b] - all[a]);
  const avgPts = hands.reduce((a, h) => a + h.myPoints, 0) / hands.length;
  const wins = hands.filter((h) => h.myPoints > 0).length;
  const losses = hands.filter((h) => h.myPoints < 0).length;
  // blocks of 10 hands for the trend
  const blocks: number[] = [];
  for (let k = 0; k + 10 <= hands.length; k += 10) blocks.push(total(leakPerHand(hands.slice(k, k + 10))));
  const bmax = Math.max(1, ...blocks);
  return (
    <div className="progress">
      <div className="stats">
        <div>
          <span className="big">{hands.length}</span> hands played
        </div>
        <div>
          <span className="big">{total(all).toFixed(1)}</span> points lost to flagged mistakes per hand
        </div>
        <div>
          <span className="big">{signed(avgPts)}</span> points per hand ({wins} won, {losses} lost)
        </div>
      </div>
      <h2>Where the points go</h2>
      <p className="note">Estimated points given up per hand, by kind of mistake. Dark bar: all hands. Light bar: your last {recent.length}.</p>
      <table className="leaks">
        <tbody>
          {sorted.map((c) => (
            <tr key={c}>
              <th scope="row">{CATEGORY_LABEL[c]}</th>
              <td className="bars">
                <span className="bar all" style={{ width: `${(100 * all[c]) / max}%` }} />
                <span className="bar recent" style={{ width: `${(100 * rec[c]) / max}%` }} />
              </td>
              <td className="num">
                {all[c].toFixed(2)}
                <span className="sub"> / {rec[c].toFixed(2)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {earlier.length >= 10 && (
        <p className="note">
          Last {recent.length} hands: {total(rec).toFixed(2)} points lost per hand, against {total(old).toFixed(2)} before that.
        </p>
      )}
      {blocks.length >= 2 && (
        <>
          <h2>Trend</h2>
          <p className="note">Points lost per hand in each block of ten hands, oldest first.</p>
          <div className="trend" role="img" aria-label={`Points lost per hand by block of ten: ${blocks.map((b) => b.toFixed(1)).join(', ')}`}>
            {blocks.slice(-30).map((b, k) => (
              <span key={k} className="col" style={{ height: `${Math.max(3, (100 * b) / bmax)}%` }} title={b.toFixed(2)} />
            ))}
          </div>
        </>
      )}
      <p className="note">
        These figures come from the coach’s value model, not from the cards that happened to fall. A move is counted only when the estimated loss is at least 1.5 points and larger than the model’s own margin of error.
      </p>
    </div>
  );
}

function Rules({ settings, update, onClear }: { settings: Settings; update: (s: Settings) => void; onClear: () => void }) {
  const r = settings.rules;
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="rules">
      <h2>Coaching</h2>
      <label>
        Opponents
        <select value={settings.level} onChange={(e) => update({ ...settings, level: e.target.value as BotLevel })}>
          {(Object.keys(LEVEL_LABEL) as BotLevel[]).map((l) => (
            <option key={l} value={l}>
              {LEVEL_LABEL[l]}
            </option>
          ))}
        </select>
      </label>
      <label>
        Coach speaks
        <select value={settings.feedback} onChange={(e) => update({ ...settings, feedback: e.target.value as Settings['feedback'] })}>
          <option value="move">After every move</option>
          <option value="hand">After the hand (in Review)</option>
          <option value="off">Never</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.useMatchScore} onChange={(e) => update({ ...settings, useMatchScore: e.target.checked })} />
        Let the game score and your partner’s result change the advice
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.showSeenCards} onChange={(e) => update({ ...settings, showSeenCards: e.target.checked })} />
        Show the cards you have seen your opponent pick up
      </label>
      <p className="note">A change of opponent takes effect on the next hand.</p>

      <h2>Table rules</h2>
      <dl>
        <dt>Partnership</dt>
        <dd>Two matchups at once; team scores combine each hand. You alternate opponents every hand. First team to {r.target} wins. No box, game or shutout bonuses.</dd>
        <dt>Oklahoma</dt>
        <dd>The upcard sets the most you can knock with (face cards 10). An ace upcard means gin only. Spades do not double.</dd>
        <dt>Scoring</dt>
        <dd>
          Gin {r.ginBonus} plus deadwood. Eleven-card gin {r.bigGinBonus} plus deadwood. Undercut {r.undercutBonus} plus the difference. A knock scores the difference.
        </dd>
        <dt>Assumed</dt>
        <dd>No laying off against gin. The hand is a draw when two stock cards remain. The loser of your last hand deals.</dd>
      </dl>
      <p className="note">The coach’s value model was trained on exactly these rules, so they are fixed in the app. If your table plays any of the assumed rules differently, the model needs retraining (see the README).</p>

      <h2>History</h2>
      {confirming ? (
        <div className="row">
          <span className="note">Delete every saved hand and statistic on this device?</span>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onClear();
              setConfirming(false);
            }}
          >
            Delete them
          </button>
          <button type="button" className="btn" onClick={() => setConfirming(false)}>
            Keep them
          </button>
        </div>
      ) : (
        <button type="button" className="btn" onClick={() => setConfirming(true)}>
          Delete saved hands and statistics
        </button>
      )}
    </div>
  );
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const [tab, setTab] = useState<Tab>('play');
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  const ref = useRef<Session | null>(null);
  if (!ref.current) ref.current = new Session(settings.rules, models, settings.level);
  const session = ref.current;
  session.level = settings.level;

  const update = (s: Settings) => {
    setSettings(s);
    saveSettings(s);
  };

  return (
    <div className="app">
      <nav className="tabs" aria-label="Sections">
        <span className="brand">Gin Coach</span>
        {(
          [
            ['play', 'Table'],
            ['review', 'Review'],
            ['progress', 'Progress'],
            ['rules', 'Rules'],
          ] as [Tab, string][]
        ).map(([t, label]) => (
          <button key={t} type="button" className={tab === t ? 'on' : ''} onClick={() => setTab(t)} aria-current={tab === t ? 'page' : undefined}>
            {label}
          </button>
        ))}
      </nav>
      <main>
        {tab === 'play' && <Play session={session} settings={settings} bump={bump} />}
        {tab === 'review' && <Review session={session} />}
        {tab === 'progress' && <Progress version={version + (tab === 'progress' ? 1 : 0)} />}
        {tab === 'rules' && (
          <Rules
            settings={settings}
            update={update}
            onClear={() => {
              clearHistory();
              bump();
            }}
          />
        )}
      </main>
    </div>
  );
}

