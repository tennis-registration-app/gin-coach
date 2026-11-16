import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { type Card, RANKS, SUITS, cardName, suitOf, rankOf } from './engine/cards';
import { type Action, type HandResult, HOUSE_RULES } from './engine/hand';
import { arrange, deadwood } from './engine/melds';
import { loadModels } from './bots/learned';
import { CATEGORY_LABEL, type Category } from './coach/analyze';
import type { ModelFile } from './coach/model';
import modelJson from './coach/model.json';
import { LEVEL_LABEL, ME, OPP, Session, type BotLevel, type DecisionRecord, type HandSummary } from './game/session';
import { clearHistory, loadDrillStats, loadHands, loadMistakes, loadRecords, loadSettings, recordDrill, saveHand, saveSettings, type Settings } from './game/storage';
import { DRILL_LABEL, drillCorrect, drillForCategory, generateDrill, loadState, type DrillKind } from './game/drills';
import { analyze, judge, type Verdict } from './coach/analyze';
import { HandState } from './engine/hand';
import { makeRng } from './engine/cards';
import lessonData from './coach/lessons.json';

const models = loadModels(modelJson as unknown as ModelFile);

type Tab = 'play' | 'practice' | 'review' | 'progress' | 'rules';

function CardView({ card, selected, onClick, small, dim, tag, fresh }: { card: Card; selected?: boolean; onClick?: () => void; small?: boolean; dim?: boolean; tag?: string; fresh?: boolean }) {
  const red = suitOf(card) === 1 || suitOf(card) === 2;
  const cls = `card${red ? ' red' : ''}${selected ? ' selected' : ''}${small ? ' small' : ''}${dim ? ' dim' : ''}${fresh ? ' fresh' : ''}${onClick ? ' tappable' : ''}`;
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

const lowerFirst = (t: string) => (t ? t[0].toLowerCase() + t.slice(1) : t);
const signed = (x: number, digits = 1) => (x >= 0 ? '+' : '−') + Math.abs(x).toFixed(digits);

function describeResult(r: HandResult, winnerName: string, loserName: string): string {
  const R = HOUSE_RULES;
  switch (r.kind) {
    case 'draw':
      return 'The stock ran down to two cards. No score.';
    case 'gin':
      return `${winnerName} went gin: ${R.ginBonus} + ${r.defenderDeadwood} = ${r.points}.`;
    case 'biggin':
      return `${winnerName} made eleven-card gin: ${R.bigGinBonus} + ${r.defenderDeadwood} = ${r.points}.`;
    case 'undercut':
      return `${loserName} knocked with ${r.knockerDeadwood} and was undercut (${r.defenderDeadwood}): ${R.undercutBonus} + ${r.knockerDeadwood - r.defenderDeadwood} = ${r.points} to ${winnerName}.`;
    case 'knock':
      return `${winnerName} knocked with ${r.knockerDeadwood} against ${r.defenderDeadwood}: ${r.points}.`;
  }
}

function CoachCard({ rec, showNumbers, reveal }: { rec: DecisionRecord; showNumbers?: boolean; reveal?: boolean }) {
  const [open, setOpen] = useState(!!showNumbers);
  const [why, setWhy] = useState(false);
  const tone = rec.flagged ? 'bad' : rec.tooClose ? 'close' : 'good';
  const hasWhy = !!rec.why && rec.why.length > 0;
  return (
    <div className={`coach ${tone}`}>
      <p className="headline">{rec.headline}</p>
      {rec.reasons.map((r, i) => (
        <p key={i}>{r}</p>
      ))}
      <div className="coachlinks">
        {hasWhy && (
          <button type="button" className="link" onClick={() => setWhy(!why)} aria-expanded={why}>
            {why ? 'Hide why' : 'Why?'}
          </button>
        )}
        <button type="button" className="link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide the numbers' : 'Show the numbers'}
        </button>
      </div>
      {why && hasWhy && (
        <div className="why">
          <p className="whyhead">
            Your play ({lowerFirst(rec.chosen)}) compared with: {lowerFirst(rec.versus ?? '')}
          </p>
          {rec.why!.map((sec) => (
            <section key={sec.title}>
              <h3>{sec.title}</h3>
              {sec.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </section>
          ))}
          {reveal && rec.hindsight && rec.hindsight.length > 0 && (
            <section>
              <h3>What the hidden cards showed</h3>
              {rec.hindsight.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </section>
          )}
        </div>
      )}
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

/** The coach's rating of a play you have not made yet. */
function PreviewCard({ title, v, knock }: { title: string; v: ReturnType<Session['preview']>; knock?: ReturnType<Session['preview']> }) {
  const same = v.chosen === v.best;
  const rate = (x: ReturnType<Session['preview']>): string => {
    if (x.chosen === x.best) return x.ties.length ? `as good as anything here (about equal: ${x.ties.slice(0, 3).join('; ')})` : 'the coach\u2019s best play';
    if (x.headline.startsWith('Unproven')) return `rated about ${x.loss.toFixed(1)} points below "${x.best.label}", but no check supports that; unproven`;
    if (x.flagged) return `gives up about ${x.loss.toFixed(1)} points (±${x.margin.toFixed(1)}). Better: ${x.best.label}`;
    return x.loss > 0.3 ? `close to best (about ${x.loss.toFixed(1)} points behind "${x.best.label}", within the margin of error)` : `about the same as "${x.best.label}"`;
  };
  const tone = v.flagged ? 'bad' : same ? 'good' : 'close';
  return (
    <div className={`coach ${tone}`} aria-live="polite">
      <p className="headline">
        {title}: {rate(v)}.
      </p>
      {knock && (
        <p>
          Knocking with this discard instead: {rate(knock)}. Expected {signed(knock.chosen.ev)} against {signed(v.chosen.ev)} for playing on.
        </p>
      )}
      {v.why.length > 0 && (
        <div className="why open">
          <p className="whyhead">Compared with: {lowerFirst(v.versus)}</p>
          {v.why.map((sec) => (
            <section key={sec.title}>
              <h3>{sec.title}</h3>
              {sec.lines.map((l, i) => (
                <p key={i}>{l}</p>
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function Play({ session, settings, bump, update }: { session: Session; settings: Settings; bump: () => void; update: (s: Settings) => void }) {
  const s = session.hand;
  const g = session.game;
  const [sel, setSel] = useState<Card | null>(null);
  const [peeking, setPeeking] = useState(false);
  const [quizPick, setQuizPick] = useState<number | null>(null);
  const saved = useRef('');
  const over = s.phase === 'over';
  const myTurn = session.myTurn;

  // opponent moves on a short delay so you can follow them
  useEffect(() => {
    if (over || myTurn || session.awaiting) return;
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

  session.pauseOnMistake = settings.feedback === 'move' && settings.takeBack;
  session.tracking = settings.tracking;
  const showPile = !over && (settings.tracking === 'open' || (settings.tracking === 'peek' && peeking));
  const act = (a: Action) => {
    session.useMatchScore = settings.useMatchScore;
    session.act(a);
    setSel(null);
    setPeeking(false);
    setQuizPick(null);
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
  if (showPile) for (let c = 0; c < 52; c++) if (s.known[OPP][c]) seen.push(c);

  const canSelect = !over && (settings.manualArrange || (myTurn && s.phase === 'discard'));
  const handCard = (c: Card) => (
    <CardView
      key={c}
      card={c}
      selected={sel === c}
      tag={c === s.justDrew && s.turn === ME && s.phase === 'discard' ? 'just drawn' : undefined}
      fresh={c === s.justDrew && s.turn === ME && s.phase === 'discard'}
      onClick={canSelect ? () => setSel(sel === c ? null : c) : undefined}
    />
  );

  let prompt = '';
  if (over) prompt = '';
  else if (session.awaiting) prompt = '';
  else if (!myTurn) prompt = `${oppName} is thinking…`;
  else if (s.phase === 'draw') prompt = s.opening <= 1 ? `Take the upcard or pass?` : s.opening === 2 ? 'Both passed. Draw from the stock.' : 'Draw from the stock or take the top discard.';
  else prompt = sel === null ? 'Tap a card to discard.' : '';
  const arranging = settings.manualArrange && sel !== null && !over;

  const partnerLine = session.partnerKnown
    ? `${g.partner} v ${session.partnerOpponentName}: ${describeResult(session.partnerResult, session.partnerResult.winner === 0 ? g.partner : session.partnerOpponentName, session.partnerResult.winner === 0 ? session.partnerOpponentName : g.partner)}`
    : `${g.partner} v ${session.partnerOpponentName}: still playing`;

  // explore mode: the coach rates an option before you commit
  const exploring = settings.explore && settings.feedback !== 'off' && myTurn && !session.analysis?.forced;
  let preview: { title: string; verdict: ReturnType<Session['preview']>; knock?: ReturnType<Session['preview']> } | null = null;
  if (exploring && s.phase === 'discard' && sel !== null && canDiscardSel) {
    session.useMatchScore = settings.useMatchScore;
    const verdict = session.preview({ type: 'discard', card: sel, knock: false });
    const knock = selDw !== null && selDw > 0 && selDw <= s.knockLimit ? session.preview({ type: 'discard', card: sel, knock: true }) : undefined;
    preview = { title: `Discarding the ${cardName(sel)}`, verdict, knock };
  } else if (exploring && s.phase === 'draw' && s.opening !== 2 && top >= 0) {
    session.useMatchScore = settings.useMatchScore;
    preview = { title: `Taking the ${cardName(top)}`, verdict: session.preview({ type: 'take' }) };
  }

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

        {showPile && (
          <div className="pile" aria-label="Discard pile, oldest first">
            <span className="count">Discard pile, oldest first ({s.discard.length})</span>
            <div className="pilecards">
              {s.discard.map((c, i) => (
                <CardView key={c} card={c} small tag={s.discardBy[i] === ME ? 'you' : s.discardBy[i] === OPP ? 'them' : 'upcard'} />
              ))}
            </div>
          </div>
        )}
        {!over && settings.tracking === 'peek' && (
          <p className="peekrow">
            <button
              type="button"
              className="link light"
              onClick={() => {
                if (!peeking) session.peek();
                setPeeking(!peeking);
              }}
            >
              {peeking ? 'Hide the pile' : 'Check the pile'}
            </button>{' '}
            <span className="count">checked {session.peeks} time{session.peeks === 1 ? '' : 's'} this hand</span>
          </p>
        )}

        <div className="me">
          <div className="handrow">
            {settings.manualArrange ? (
              <div className="group manual">{session.myOrder().map(handCard)}</div>
            ) : (
              <>
                {arr.melds.map((m, i) => (
                  <div className="group meld" key={i}>
                    {m.map(handCard)}
                  </div>
                ))}
                <div className="group">{arr.deadwoodCards.map(handCard)}</div>
              </>
            )}
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
          {arranging && (
            <>
              <button type="button" className="btn" aria-label="Move the selected card left" onClick={() => { session.moveCard(sel!, -1); bump(); }}>
                ◀ Move
              </button>
              <button type="button" className="btn" aria-label="Move the selected card right" onClick={() => { session.moveCard(sel!, 1); bump(); }}>
                Move ▶
              </button>
            </>
          )}
          {settings.manualArrange && !over && sel === null && (
            <button type="button" className="link light" onClick={() => { session.sortHand(); bump(); }}>
              Sort my hand
            </button>
          )}
          {myTurn && settings.feedback !== 'off' && (
            <button type="button" className="link light" aria-pressed={settings.explore} onClick={() => update({ ...settings, explore: !settings.explore })}>
              {settings.explore ? 'Coach my options: on' : 'Coach my options: off'}
            </button>
          )}
          {exploring && s.phase === 'discard' && sel === null && <span className="prompt hint">Tap any card to see how the coach rates discarding it.</span>}
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

      {session.quiz && myTurn && (
        <div className="coach close quiz">
          <p className="headline">Card check: {session.quiz.question}</p>
          <div className="quizopts">
            {session.quiz.options.map((o, i) => (
              <button
                key={o}
                type="button"
                className={`btn${quizPick !== null && i === session.quiz!.answer ? ' right' : ''}${quizPick === i && i !== session.quiz!.answer ? ' wrong' : ''}`}
                disabled={quizPick !== null}
                onClick={() => {
                  session.answerQuiz(i);
                  setQuizPick(i);
                }}
              >
                {o}
              </button>
            ))}
          </div>
          {quizPick !== null ? (
            <p>
              {quizPick === session.quiz.answer ? 'Right.' : 'Not quite.'} {session.quiz.explain}
            </p>
          ) : (
            <p className="whyhead">Answer if you like, or just play on to skip it.</p>
          )}
        </div>
      )}

      {preview && <PreviewCard title={preview.title} v={preview.verdict} knock={preview.knock} />}

      {showCoach && !preview && <CoachCard key={`${session.handId}-${lastRec.idx}`} rec={lastRec} reveal={over} />}
      {session.awaiting && (
        <div className="takeback">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              session.takeBack();
              setSel(null);
              bump();
            }}
          >
            Take it back and try again
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              session.keepPlay();
              bump();
            }}
          >
            Keep my play
          </button>
          <span className="note">Your first play still counts in Progress.</span>
        </div>
      )}

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
        <p className="replay-meta">
          You chose: {lowerFirst(rec.chosen)}.{rec.retried ? ' You then took it back.' : ''}{rec.retry ? ' (Second attempt, not counted in Progress.)' : ''}
        </p>
      </section>
      <CoachCard key={`${handRec.id}-${i}`} rec={rec} showNumbers reveal={!inProgress} />
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

type DrillChoice = 'mixed' | 'mistakes' | DrillKind;
const drillRng = makeRng((Date.now() ^ 0x5bd1e995) >>> 0);

interface LessonCell {
  n: number;
  winPct?: number;
  undercutPct?: number;
  avgPts?: number;
  coachKnockPct?: number;
  edge?: number;
  takePct?: number;
}
const L = lessonData as unknown as {
  hands: number;
  rules: { undercut: number; gin: number };
  stages: string[];
  knock: (LessonCell | null)[][];
  gin: (LessonCell | null)[];
  pile: Record<string, (LessonCell | null)[]>;
};

function Lessons() {
  const dws = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const cell = (c: LessonCell | null | undefined, f: (c: LessonCell) => string) => (c ? f(c) : '');
  return (
    <div className="lessons">
      <p className="note">
        These tables come from {L.hands.toLocaleString()} hands of the trained bot playing itself under your table’s rules (gin {L.rules.gin}, undercut {L.rules.undercut}). The first shows what actually happened; the others show what the coach’s models prefer. The bot keeps playing when it is close to gin, so positions from the middle and late stages lean toward hands with gin chances. Blank cells had too few cases to report.
      </p>

      <details>
        <summary>What happens when you knock</summary>
        <p>
          Each cell is the share of knocks that won, and the average points the knock scored (undercuts counted as losses), measured against the opponent’s real hand at that moment.
        </p>
        <div className="scroll">
          <table className="lesson">
            <thead>
              <tr>
                <th scope="col">Knocking with</th>
                {L.stages.map((st) => (
                  <th scope="col" key={st}>
                    {st}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dws.map((d) => (
                <tr key={d}>
                  <th scope="row">{d}</th>
                  {L.stages.map((_, i) => (
                    <td key={i}>{cell(L.knock[i][d], (c) => `${c.winPct}% won, ${signed(c.avgPts ?? 0)}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details>
        <summary>When the coach prefers to knock</summary>
        <p>The share of positions in which the coach rated knocking above playing on, and by how many points on average (negative means playing on rated higher).</p>
        <div className="scroll">
          <table className="lesson">
            <thead>
              <tr>
                <th scope="col">Deadwood</th>
                {L.stages.map((st) => (
                  <th scope="col" key={st}>
                    {st}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dws.map((d) => (
                <tr key={d}>
                  <th scope="row">{d}</th>
                  {L.stages.map((_, i) => (
                    <td key={i}>{cell(L.knock[i][d], (c) => `knock ${c.coachKnockPct}%, ${signed(c.edge ?? 0)}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <details>
        <summary>Live gin cards and the decision to knock</summary>
        <p>When you could knock, how the number of cards that would give you gin next turn changes the coach’s preference.</p>
        <table className="lesson">
          <thead>
            <tr>
              <th scope="col">Live gin cards</th>
              <th scope="col">Coach prefers knocking</th>
              <th scope="col">Average edge for knocking</th>
            </tr>
          </thead>
          <tbody>
            {L.gin.map((c, i) => (
              <tr key={i}>
                <th scope="row">{i === 4 ? '4 or more' : i}</th>
                <td>{cell(c, (x) => `${x.coachKnockPct}%`)}</td>
                <td>{cell(c, (x) => signed(x.edge ?? 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <details>
        <summary>Taking the pile card</summary>
        <p>How often the coach prefers taking the top discard, by what the card does for your hand. This is the least tested part of the coach’s advice.</p>
        <div className="scroll">
          <table className="lesson">
            <thead>
              <tr>
                <th scope="col">The pile card</th>
                {L.stages.map((st) => (
                  <th scope="col" key={st}>
                    {st}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['new', 'Adds a meld cleanly'],
                  ['swap', 'Melds only by breaking another meld'],
                  ['none', 'Does not meld'],
                ] as const
              ).map(([k, label]) => (
                <tr key={k}>
                  <th scope="row">{label}</th>
                  {L.stages.map((_, i) => (
                    <td key={i}>{cell(L.pile[k]?.[i], (c) => `take ${c.takePct}%`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function Practice({ settings }: { settings: Settings }) {
  const [choice, setChoice] = useState<DrillChoice>('mixed');
  const [pos, setPos] = useState<HandState | null>(null);
  const [kind, setKind] = useState<string>('');
  const [note, setNote] = useState('');
  const [sel, setSel] = useState<Card | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [tally, setTally] = useState({ tried: 0, right: 0 });
  const [mistakeIdx, setMistakeIdx] = useState(0);
  const mistakes = useMemo(() => loadMistakes().reverse(), [pos]); // eslint-disable-line
  const stats = useMemo(() => loadDrillStats(), [verdict]); // eslint-disable-line
  const an = useMemo(() => (pos ? analyze(pos, models) : null), [pos]);

  const next = (which: DrillChoice = choice) => {
    setSel(null);
    setVerdict(null);
    setNote('');
    if (which === 'mistakes') {
      if (mistakes.length === 0) {
        setPos(null);
        setNote('No saved mistakes yet. Mistakes the coach flags at the table from now on are kept here to replay.');
        return;
      }
      const mk = mistakes[mistakeIdx % mistakes.length];
      setMistakeIdx(mistakeIdx + 1);
      setKind('mistakes');
      setNote(`From your own play. You chose: ${lowerFirst(mk.played)} (about ${mk.loss.toFixed(1)} points lost).`);
      setPos(loadState(mk.state, settings.rules));
      return;
    }
    let k: DrillKind;
    if (which === 'mixed') {
      // weight the kinds of drill by where your flagged points have gone
      const w: Record<DrillKind, number> = { knock: 1, discard: 1, draw: 1 };
      for (const h of loadHands().slice(-200)) for (const c of CATS) w[drillForCategory(c)] += h.lossByCat[c] ?? 0;
      let r = drillRng() * (w.knock + w.discard + w.draw);
      k = (r -= w.knock) < 0 ? 'knock' : (r -= w.discard) < 0 ? 'discard' : 'draw';
    } else k = which;
    const s = generateDrill(k, settings.rules, models, drillRng);
    setKind(k);
    if (!s) setNote('Could not find a suitable position this time. Try again.');
    setPos(s);
  };

  const answer = (a: Action) => {
    if (!pos || !an || verdict) return;
    const v = judge(pos, an, a, false);
    recordDrill(kind, drillCorrect(v));
    setTally({ tried: tally.tried + 1, right: tally.right + (drillCorrect(v) ? 1 : 0) });
    setVerdict(v);
  };

  const p = pos ? pos.turn : 0;
  const hand = pos ? pos.hands[p] : [];
  const arr = pos ? arrange(hand) : null;
  const top = pos ? pos.topDiscard : -1;
  const selDw = pos && sel !== null ? deadwood(hand.filter((c) => c !== sel)) : null;
  const seen: Card[] = [];
  if (pos) for (let c = 0; c < 52; c++) if (pos.known[1 - p][c]) seen.push(c);
  const handCard = (c: Card) => (
    <CardView key={c} card={c} selected={sel === c} tag={pos && c === pos.justDrew ? 'just drawn' : undefined} fresh={!!pos && c === pos.justDrew} onClick={pos && pos.phase === 'discard' && !verdict ? () => setSel(sel === c ? null : c) : undefined} />
  );

  return (
    <div className="practice">
      <h2>Drills</h2>
      <div className="row drillpick">
        <label>
          Drill{' '}
          <select
            value={choice}
            onChange={(e) => {
              setChoice(e.target.value as DrillChoice);
              setPos(null);
              setVerdict(null);
              setNote('');
            }}
          >
            <option value="mixed">Mixed, weighted toward your leaks</option>
            <option value="mistakes">Replay my mistakes ({mistakes.length} saved)</option>
            <option value="knock">{DRILL_LABEL.knock}</option>
            <option value="discard">{DRILL_LABEL.discard}</option>
            <option value="draw">{DRILL_LABEL.draw}</option>
          </select>
        </label>
        <button type="button" className="btn primary" onClick={() => next()}>
          {pos ? 'Next position' : 'Start'}
        </button>
        {tally.tried > 0 && (
          <span className="note">
            This session: {tally.right} of {tally.tried} right
          </span>
        )}
      </div>
      {note && <p className="note">{note}</p>}

      {pos && arr && (
        <section className="felt">
          <p className="replay-meta">
            {kind === 'mistakes' ? 'Your move again' : DRILL_LABEL[kind as DrillKind]}. {pos.knockLimit === 0 ? 'Gin only' : `Knock at ${pos.knockLimit} or less`}. {pos.stock.length} in the stock.
            {seen.length > 0 ? ` Your opponent has picked up ${seen.map(cardName).join(', ')}.` : ''}
          </p>
          <div className="pile" aria-label="Discard pile, oldest first">
            <span className="count">Discard pile, oldest first; the last card is on top</span>
            <div className="pilecards">
              {pos.discard.map((c, i) => (
                <CardView key={c} card={c} small tag={pos.discardBy[i] === p ? 'you' : pos.discardBy[i] === 1 - p ? 'them' : i === 0 && pos.discardBy.length ? 'upcard' : undefined} />
              ))}
            </div>
          </div>
          <div className="me">
            <div className="handrow">
              {arr.melds.map((mm, i) => (
                <div className="group meld" key={i}>
                  {mm.map(handCard)}
                </div>
              ))}
              <div className="group">{arr.deadwoodCards.map(handCard)}</div>
            </div>
            <p className="deadwood">
              Deadwood {arr.deadwood}
              {selDw !== null && sel !== null ? `, ${selDw} after discarding the ${cardName(sel)}` : ''}
            </p>
          </div>
          {verdict && (
            <div className="opp">
              <span className="name">Your opponent was holding</span>
              <Spread cards={pos.hands[1 - p]} small />
            </div>
          )}
          {!verdict && (
            <div className="actions">
              {pos.phase === 'draw' && (
                <>
                  <button type="button" className="btn" onClick={() => answer({ type: 'take' })}>
                    Take the {cardName(top)}
                  </button>
                  <button type="button" className="btn" onClick={() => answer(pos.opening <= 1 ? { type: 'pass' } : { type: 'stock' })}>
                    {pos.opening <= 1 ? 'Pass' : 'Draw from the stock'}
                  </button>
                </>
              )}
              {pos.phase === 'discard' && arr.deadwood === 0 && (
                <button type="button" className="btn primary" onClick={() => answer({ type: 'biggin' })}>
                  Declare eleven-card gin
                </button>
              )}
              {pos.phase === 'discard' && sel === null && <span className="prompt">Tap the card you would discard.</span>}
              {pos.phase === 'discard' && sel !== null && sel === pos.justTaken && <span className="prompt">You can’t discard the card you just took.</span>}
              {pos.phase === 'discard' && sel !== null && sel !== pos.justTaken && (
                <>
                  <button type="button" className="btn" onClick={() => answer({ type: 'discard', card: sel, knock: false })}>
                    Discard the {cardName(sel)}
                  </button>
                  {selDw !== null && selDw <= pos.knockLimit && (
                    <button type="button" className="btn primary" onClick={() => answer({ type: 'discard', card: sel, knock: true })}>
                      {selDw === 0 ? 'Go gin' : `Knock with ${selDw}`}
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </section>
      )}

      {verdict && (
        <div className={`coach ${drillCorrect(verdict) ? 'good' : 'bad'}`}>
          <p className="headline">
            {verdict.chosen === verdict.best
              ? 'Right. That is the coach’s best play.'
              : drillCorrect(verdict)
                ? `Right. The coach rates "${verdict.best.label}" about the same.`
                : `The coach prefers "${verdict.best.label}" by about ${verdict.loss.toFixed(1)} points (±${verdict.margin.toFixed(1)}).`}
          </p>
          {verdict.why.length > 0 && (
            <div className="why open">
              <p className="whyhead">
                Your play ({lowerFirst(verdict.chosen.label)}) compared with: {lowerFirst(verdict.versus)}
              </p>
              {verdict.why.map((sec) => (
                <section key={sec.title}>
                  <h3>{sec.title}</h3>
                  {sec.lines.map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                </section>
              ))}
            </div>
          )}
          <button type="button" className="btn primary" onClick={() => next()}>
            Next position
          </button>
        </div>
      )}

      {Object.keys(stats).length > 0 && (
        <p className="note">
          All time:{' '}
          {Object.entries(stats)
            .map(([k, v]) => `${k === 'mistakes' ? 'replayed mistakes' : DRILL_LABEL[k as DrillKind].toLowerCase()} ${v.right} of ${v.tried}`)
            .join('; ')}
          .
        </p>
      )}

      <h2>Lessons from the trained coach</h2>
      <Lessons />
    </div>
  );
}



function leakPerHand(hands: HandSummary[]): Record<Category, number> {
  const out = Object.fromEntries(CATS.map((c) => [c, 0])) as Record<Category, number>;
  for (const h of hands) for (const c of CATS) out[c] += h.lossByCat[c] ?? 0;
  for (const c of CATS) out[c] = hands.length ? out[c] / hands.length : 0;
  return out;
}

function Progress({ version }: { version: number }) {
  const allHands = useMemo(() => loadHands(), [version]); // eslint-disable-line
  const aidedHands = allHands.filter((h) => h.aided);
  const unaided = allHands.filter((h) => !h.aided);
  // leak figures describe unaided play; fall back to aided hands only if that is all there is
  const hands = unaided.length ? unaided : allHands;
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
          <span className="big">{hands.length}</span> {unaided.length ? 'unaided hands' : 'hands'} played
        </div>
        <div>
          <span className="big">{total(all).toFixed(1)}</span> points lost to flagged mistakes per hand
        </div>
        <div>
          <span className="big">{signed(avgPts)}</span> points per hand ({wins} won, {losses} lost)
        </div>
      </div>
      {aidedHands.length > 0 && unaided.length > 0 && (
        <p className="note">
          Plus {aidedHands.length} hand{aidedHands.length === 1 ? '' : 's'} played with the coach rating your options first ({total(leakPerHand(aidedHands)).toFixed(2)} points lost per hand). Those are left out of the figures on this page.
        </p>
      )}
      {aidedHands.length > 0 && unaided.length === 0 && <p className="note">All of these hands were played with the coach rating your options first, so the figures understate your unaided mistakes.</p>}
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
      {(() => {
        const levels = [
          ['open', 'Open pile'],
          ['peek', 'Check on request'],
          ['none', 'No help'],
        ] as const;
        const rows = levels.map(([k, label]) => ({ k, label, hs: hands.filter((h) => (h.tracking ?? 'open') === k) })).filter((r) => r.hs.length > 0);
        if (rows.length === 0) return null;
        return (
          <>
            <h2>Card tracking</h2>
            <p className="note">Your results at each level of card-tracking help. The aim is for points lost per hand to hold steady as the help comes off.</p>
            <table className="tracking">
              <thead>
                <tr>
                  <th scope="col">Help</th>
                  <th scope="col">Hands</th>
                  <th scope="col">Points lost per hand</th>
                  <th scope="col">Pile checks per hand</th>
                  <th scope="col">Memory questions right</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const asked = r.hs.reduce((a, h) => a + (h.quizAsked ?? 0), 0);
                  const right = r.hs.reduce((a, h) => a + (h.quizCorrect ?? 0), 0);
                  const peeks = r.hs.reduce((a, h) => a + (h.peeks ?? 0), 0);
                  return (
                    <tr key={r.k}>
                      <th scope="row">{r.label}</th>
                      <td>{r.hs.length}</td>
                      <td>{total(leakPerHand(r.hs)).toFixed(2)}</td>
                      <td>{r.k === 'peek' ? (peeks / r.hs.length).toFixed(1) : ''}</td>
                      <td>{asked ? `${right} of ${asked}` : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        );
      })()}
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
        <input type="checkbox" checked={settings.explore} onChange={(e) => update({ ...settings, explore: e.target.checked })} />
        Coach my options before I commit (hands played this way are counted separately as aided)
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.takeBack} onChange={(e) => update({ ...settings, takeBack: e.target.checked })} />
        Pause after a flagged mistake so I can take the play back
      </label>
      <label>
        Card-tracking help
        <select value={settings.tracking} onChange={(e) => update({ ...settings, tracking: e.target.value as Settings['tracking'] })}>
          <option value="open">Open pile: every discard and pickup stays visible</option>
          <option value="peek">On request: top card only, with a counted check of the pile</option>
          <option value="none">None: top card only, with an occasional memory question</option>
        </select>
      </label>
      <label className="check">
        <input type="checkbox" checked={settings.manualArrange} onChange={(e) => update({ ...settings, manualArrange: e.target.checked })} />
        Arrange my hand myself (cards stay where you put them; new cards arrive on the right)
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
        <dd>No laying off against gin. The hand is a draw when two stock cards remain. The winner of your last hand deals the next.</dd>
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
            ['practice', 'Practice'],
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
        {tab === 'play' && <Play session={session} settings={settings} bump={bump} update={update} />}
        {tab === 'practice' && <Practice settings={settings} />}
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

