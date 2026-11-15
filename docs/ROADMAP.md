# Improvement backlog

Items collected before and during alpha testing. Order and scope will be set once testing shows which matter most.

## From alpha testing

1. **Why button (in-app).** On the coach's verdict after every move, including close calls and moves it agrees with, and on the "Ask the coach first" hint. Compares your play with the coach's play on four checks, every time, ordered with the biggest difference first:
   - *What can improve each card:* the live cards that would meld it, and the dead ones with where they went (pile, your hand, opponent's known cards). Notes when an out is suspect because the opponent picked up a related card.
   - *How safe each discard is:* whether the opponent could use it in any meld given the visible cards. Includes a new exact check for discards that are provably unusable.
   - *What each costs if the opponent goes out:* the points you would still be carrying.
   - *What each does to your knock and gin chances:* which draws would let you knock or gin afterwards.
   In Review, after the hand, it also shows what the opponent actually held. Built from computed facts with written templates; no API, works offline. Covering all four checks each time is how it addresses the player's own reasoning without being told it; plain wording is acceptable.
2. **Hint shows ties.** When several plays are within the margin of error, the hint lists them as effectively equal instead of naming one.
3. **Ask a follow-up (optional, low priority).** Conversational questions about a position through an AI API. Needs a small server to hold the key, costs a little per question, and does not work offline. The app must send the coach's computed facts and restrict the explanation to them. Only worth building if the Why button leaves questions unanswered.
4. **Drag to arrange.** Drag-and-drop in the arrange-my-own-hand mode, if tapping Move proves slow.

5. **Hand log capitalisation.** Your own cards appear in lower case ("k♣", "a♥"); small fix.

## From the review of other gin apps

6. **Drills.** Replay positions you got wrong; endless knock-or-wait and discard drills, weighted toward your biggest leak categories.
7. **Short lessons for these table rules.** Taken from what the trained model does (for example knock timing by upcard), not from general book advice.
8. **Card-tracking aid and memory trainer, in three levels.** (a) Open pile: the whole discard pile laid out in order, marked by who threw each card, alongside the cards you have seen your opponent take. (b) Top card only, as at a real table, with a "check the pile" peek that is counted. (c) No aids, with occasional mid-hand quizzes on which cards are gone. The Progress tab notes which level each hand was played at.
9. **History export and cross-device statistics.** Export and import first; sync through a small backend later.
10. **Enter a real hand.** Record a hand from an actual game for a post-mortem.
11. **Opponents with human styles.** Early knocker, gin chaser, speculative picker.
12. **Rule variants.** One retraining run per rule set.

## Done

- Highlight the card just drawn.
- Option to arrange your own hand (tap, then Move).
