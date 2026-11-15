# Improvement backlog

Items collected before and during alpha testing. Order and scope will be set once testing shows which matter most.

## From alpha testing

1. **Why button (in-app).** On the coach's verdict after every move, including close calls and moves it agrees with, and on the "Ask the coach first" hint. Shows your play and the coach's play side by side: deadwood left, the live cards that would improve each hand, how safe each discard is and why, and for knock decisions the chances of winning, being undercut, and the opponent going gin. Built from the coach's computed facts with written templates; no API, works offline.
2. **Hint shows ties.** When several plays are within the margin of error, the hint lists them as effectively equal instead of naming one.
3. **Ask a follow-up (optional, later).** Conversational questions about a position through an AI API. Needs a small server to hold the key, costs a little per question, and does not work offline. The app must send the coach's computed facts and restrict the explanation to them. Only worth building if the Why button leaves questions unanswered.
4. **Drag to arrange.** Drag-and-drop in the arrange-my-own-hand mode, if tapping Move proves slow.

## From the review of other gin apps

5. **Drills.** Replay positions you got wrong; endless knock-or-wait and discard drills, weighted toward your biggest leak categories.
6. **Short lessons for these table rules.** Taken from what the trained model does (for example knock timing by upcard), not from general book advice.
7. **Card-tracking aid and memory trainer.** Optional tracker overlay; mid-hand quizzes on which cards are gone.
8. **History export and cross-device statistics.** Export and import first; sync through a small backend later.
9. **Enter a real hand.** Record a hand from an actual game for a post-mortem.
10. **Opponents with human styles.** Early knocker, gin chaser, speculative picker.
11. **Rule variants.** One retraining run per rule set.

## Done

- Highlight the card just drawn.
- Option to arrange your own hand (tap, then Move).
