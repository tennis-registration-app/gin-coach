# Gin Coach

Practice four-player partnership Oklahoma gin against bots, with a coach that grades every draw, discard and knock, tells you roughly how many points a mistake cost, and tracks which kinds of mistakes cost you the most over time.

Play it at https://tennis-registration-app.github.io/gin-coach/

The app is a static web app (React, TypeScript, Vite). Everything runs in the browser, including the bots and the coach, and it works offline after the first load. Hands and statistics are saved on the device.

## Table rules

The engine implements one table's house rules (`HOUSE_RULES` in `src/engine/hand.ts`).

- Four players in two partnerships. Two two-handed matchups are played at once and the team scores combine each hand. You alternate between the two opponents every hand. Partners are redrawn after each game.
- First team to 150 wins. There are no box, game or shutout bonuses.
- Oklahoma: the first upcard sets the highest count you can knock with (face cards count 10). An ace upcard means gin only. Spades do not double.
- Gin scores 25 plus the opponent's deadwood. Eleven-card gin scores 50 plus deadwood. An undercut scores 20 plus the difference. A knock scores the difference.
- You cannot see your partner's hand, but you see the result of their matchup once it finishes.

The winner of your previous hand deals the next. Three details were assumed rather than confirmed, and are flagged in the app's Rules tab: no laying off against gin, the hand is a draw when two stock cards remain, and the non-dealer is offered the upcard first.

## How the coach works

The coach sees only what you see: your hand, the discard pile, the knock limit, the stock count, and the cards your opponent picked up, discarded or declined. A test (`src/coach/coach.test.ts`) confirms that shuffling the hidden cards between the opponent's hand and the stock never changes its advice.

It rates each option in expected points for the hand, using two small neural networks trained on bot self-play under these exact rules:

- a position model that estimates the result of the hand after each possible discard, from features such as deadwood, the number of live cards that would complete a meld, how many draws would let you knock or gin, how far the stock has run down, and how dangerous the discard is given what the opponent has shown;
- a knock model that estimates the result of knocking now, including the chance of being undercut.

Every verdict carries a Why panel comparing your play with the coach's on four checks, computed with the same meld search as the numbers: what could still improve each card, whether your opponent could use the discard, what each card costs if your opponent goes out, and which draws would then let you knock or gin.

Two optional aids build on this. With "Coach my options" switched on, the coach rates a discard as soon as you tap the card, and rates both options at a draw decision, before you commit; hands played this way are reported separately as aided. After a flagged mistake the opponent waits so you can take the play back and try again; the first attempt is the one that counts in your statistics, and a taken-back stock draw is reshuffled.

Card-tracking help comes in three levels, set in the Rules tab: the whole discard pile and the opponent's pickups kept visible; the top card only, with a counted check of the pile; or no help, with about one memory question a hand. Progress reports results at each level.

The Practice tab offers drills: generated positions for knock decisions, discards and pile-card decisions, a mix weighted toward the categories where your flagged points have gone, and replays of your own flagged mistakes (kept with their full position). It also shows four tables built by `sim/lessons.ts` from bot self-play: what actually happens when you knock, when the coach prefers to knock, how live gin cards change that, and when it prefers the pile card.

Draw decisions are rated by looking one draw ahead: the value of taking the pile card against the average over every card that could come off the stock.

A move is flagged only when the estimated loss is at least 1.5 points (3 for draw decisions) and larger than the coach's margin of error, which comes from the disagreement among three independently trained copies of each model. Closer calls are reported as close calls. Flagged mistakes are sorted into categories (discard-pile decisions, holding high cards, feeding the opponent, breaking up combinations, knocking too early, knocking too late), and the Progress tab shows points lost per hand in each.

When the option is switched on, the advice also accounts for the game score and your partner's result, using a table of game-win chances built from simulated games to 150.

## Measured results

All figures are from `sim/` scripts under the house rules. Each deal is played twice with the seats swapped. Win percentages are of hands that were not draws.

| Matchup | Hands | Hands won | Points per hand |
| --- | --- | --- | --- |
| Strong v Baseline | 10,000 | 53.7% (±0.5) | +6.3 |
| Expert v Baseline | 3,000 | 54.1% (±0.9) | +6.7 |
| Strong v Medium | 10,000 | 49.7% (±0.5) | +3.5 |
| Medium v Baseline | 10,000 | 53.7% (±0.5) | +1.6 |
| Expert v Strong | 3,000 | 50.6% (±0.9) | +0.4 |

- Baseline is a port of the published policy of the EAAI 2021 Gin Rummy Challenge's `SimpleGinRummyPlayer` (take the pile card only if it melds, discard to the lowest deadwood, knock as soon as legal), adapted to the Oklahoma knock limit.
- Medium is a hand-written rule-based bot. Strong follows the coach's discard and knock advice. Expert also uses the coach's one-draw lookahead.
- The original target was 60% of hands against Baseline. The best bot reaches 54%. The models were trained to maximise points, not hands won: the trained bots win about as many hands as the rule-based bot but win bigger ones, mostly by going gin more often.
- Coach validity: a bot that follows the coach's discard and knock advice beats the rule-based bot by 3.5 points a hand and Baseline by 6.3. The draw-decision lookahead added no measurable strength over the plain rule (Expert v Strong), which is why draw decisions are flagged only at a higher threshold.
- Speed, on the build machine: a discard analysis takes under 1 ms and a draw analysis about 14 ms (median), so the coach runs on the main thread with no worker.

## Limitations

- The coach is a strong estimate, not a solved game. Its numbers are model predictions with a stated margin of error. The margin reflects disagreement among the models and does not capture mistakes they all share.
- The models learned from bots that play like themselves. Advice assumes a competent opponent and does not adapt to a particular player's habits.
- Opening take-or-pass decisions and holding a gin hand without declaring it are rated with rougher approximations.
- The game-score adjustment treats your partner's unfinished hand as neutral.
- If your table plays any rule differently, retrain the models (below) so the advice matches.

## Development

```
npm install
npm run dev        # local dev server
npm test           # unit, property and game-flow tests
npm run build      # production build in dist/
```

Pushing to `main` runs the tests and deploys to GitHub Pages (`.github/workflows/deploy.yml`).

### Layout

- `src/engine/` rules engine: cards, meld search, hand flow, scoring. No UI dependencies.
- `src/bots/` baseline, rule-based and trained bots.
- `src/coach/` features, models, analysis, explanations, game-win table.
- `src/game/` partnership game flow and local storage.
- `src/App.tsx`, `src/index.css` the interface.
- `sim/` simulation, training and measurement scripts.

### Retraining the models

Needs Python 3 with numpy and scikit-learn. Each round generates self-play hands with the current model, trains a new one, and measures it.

```
mkdir -p data
npx tsx sim/gen.ts g0_1 40000 101 none 0.2      # first round uses the rule-based bot
python3 sim/train.py data/model1.json g0_1
sim/iterate.sh data/model1.json g1 45000        # repeat until the new model stops beating the old
cp data/model_g1.json src/coach/model.json
npx tsx sim/equity.ts src/coach/model.json 60000
npx tsx sim/lessons.ts 20000                    # rebuild the lesson tables
npx tsx sim/lv.ts src/coach/model.json 5000 strong simple
```

After a rule change, `sim/retrain.sh` runs the whole sequence (about 35 minutes on two cores). The shipped model was retrained this way for the 20-point undercut, the last round on about 2.5 million positions from 180,000 hands.
