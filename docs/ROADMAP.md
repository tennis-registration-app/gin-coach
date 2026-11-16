# Implementation plan

Each phase ends with a deploy and a round of play-testing before the next begins. Item numbers refer to the backlog below.

## Phase 1: explanations you can learn from (items 1 and 2) — done 15 Nov 2026

The foundation for everything else.

- A facts module that computes the four checks for any candidate play: what can improve each card (live, dead, suspect and competing outs), whether the discard is usable by the opponent (including the exact "provably unusable" check), what the card costs if the opponent goes out, and which draws would then let you knock or gin.
- A Why panel on every verdict, including close calls and plays the coach agrees with, ordered by biggest difference.
- The short text on flagged mistakes rebuilt from the same four checks.
- The hint lists near-equal plays as equal.
- Done when: the two hands from alpha testing (the A-hearts against 9-clubs discard, and the 3-clubs against 8-clubs discard) produce the explanations worked out by hand, and a test confirms no explanation contradicts the meld search.

## Phase 2: coaching before you commit (items 1 and 4) — done 16 Nov 2026

- Explore mode: tap a card to see its rating and four checks before discarding; the same on draw decisions. Replaces "Ask the coach first".
- Take back a move, with the first attempt still counted and stock draws reshuffled.
- Progress separates aided hands from unaided hands.

## Phase 3: card tracking (item 7) — done 16 Nov 2026

- Open pile view, then top card with a counted peek, then no aids with quizzes.
- Progress shows results by aid level.

## Phase 4: drills and lessons (items 5 and 6) — done 16 Nov 2026

- Replay the positions you got wrong.
- Generated drills by category, weighted toward your largest leaks.
- Short lessons taken from the trained model, starting with knock timing by upcard and stage of the hand.

## Phase 5: closer to your real table (items 3, 9 and 10)

- Enter a real hand for a post-mortem.
- Opponents with human styles, based on the habits seen at your table.
- Drag to arrange, if still wanted.

## Not scheduled

- History export and cross-device statistics (item 8): left for now.
- Rule variants (item 11): if added, standard gin first.

# Improvement backlog

Items collected before and during alpha testing. Order and scope will be set once testing shows which matter most.

## From alpha testing

1. **Why button (in-app).** On the coach's verdict after every move, including close calls and moves it agrees with, and on the "Ask the coach first" hint. Compares your play with the coach's play on four checks, every time, ordered with the biggest difference first:
   - *What can improve each card:* the live cards that would meld it, and the dead ones with where they went (pile, your hand, opponent's known cards). Notes when an out is suspect because the opponent picked up a related card, and when a card's partner also belongs to another combination, so that some outs compete with each other.
   - *How safe each discard is:* whether the opponent could use it in any meld given the visible cards. Includes a new exact check for discards that are provably unusable.
   - *What each costs if the opponent goes out:* the points you would still be carrying.
   - *What each does to your knock and gin chances:* which draws would let you knock or gin afterwards.
   In Review, after the hand, it also shows what the opponent actually held. Built from computed facts with written templates; no API, works offline. Covering all four checks each time is how it addresses the player's own reasoning without being told it; plain wording is acceptable. The short explanation shown on a flagged mistake should use the same four checks; today it reports only the first matching reason (for example deadwood alone).
   *Explore mode (before you commit):* with coaching switched on, tapping any card in your hand shows the coach's rating of discarding it (best, close to best, or roughly how many points it gives up) and the four checks for that card, before you press Discard. Tapping the stock or pile on a draw decision does the same. This replaces "Ask the coach first". Hands played with explore mode on are counted separately in Progress as aided hands, so unaided leak figures stay honest.
2. **Hint shows ties.** When several plays are within the margin of error, the hint lists them as effectively equal instead of naming one.
3. **Drag to arrange.** Drag-and-drop in the arrange-my-own-hand mode, if tapping Move proves slow.

4. **Take back a move.** After the coach's verdict, a "Take it back" button returns you to the decision so you can try the better play. Rules: the first attempt is what counts in Progress, so statistics stay honest, and the retry is marked as a retry. Taking back a pile pickup or a discard reveals nothing new. Taking back a stock draw would show you a hidden card, so the unseen cards are reshuffled before you redraw. Available until the opponent has acted; taking back further than that is left for Review-based drills.

## From the review of other gin apps

5. **Drills.** Replay positions you got wrong; endless knock-or-wait and discard drills, weighted toward your biggest leak categories.
6. **Short lessons for these table rules.** Taken from what the trained model does (for example knock timing by upcard), not from general book advice.
7. **Card-tracking aid and memory trainer, in three levels.** (a) Open pile: the whole discard pile laid out in order, marked by who threw each card, alongside the cards you have seen your opponent take. (b) Top card only, as at a real table, with a "check the pile" peek that is counted. (c) No aids, with occasional mid-hand quizzes on which cards are gone. The Progress tab notes which level each hand was played at.
8. **History export and cross-device statistics.** Export and import first; sync through a small backend later.
9. **Enter a real hand.** Record a hand from an actual game for a post-mortem.
10. **Opponents with human styles.** Early knocker, gin chaser, speculative picker.
11. **Rule variants.** One retraining run per rule set.

## Done

- Highlight the card just drawn.
- Option to arrange your own hand (tap, then Move).
- Explanations count only real outs: a partner already locked in a better meld no longer creates a false out.
- Hand log capitalisation.
- Winner of the previous hand deals (was loser).
- Undercut bonus 20 (was 10) and game to 150 (was 200); coach retrained on the new rules.

- Phase 1: four-check explanations on every verdict (Why panel), flagged-mistake text built from the same checks, hint lists near-equal plays, hindsight notes after the hand.
- Why panel states how the checks line up; a verdict that no check supports is shown as unproven and not counted as a mistake.
- Phase 2: explore mode (the coach rates a discard when you tap the card, and both draw options at a draw decision), take back a flagged play, aided hands reported separately in Progress.
- Phase 3: card-tracking help in three levels (open pile, counted check, none with a memory question), with results by level in Progress.
- Phase 4: Practice tab with drills (knock or play on, choose the discard, take or draw, a mix weighted toward your leaks, and replay of your own flagged mistakes) and four data tables from the trained coach.

## Dropped

- Ask a follow-up through an AI API. Explanations stay inside the app.
