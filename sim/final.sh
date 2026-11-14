#!/bin/bash
set -e
python3 sim/train.py data/model_final.json g1_1 g1_2 g2_1 g2_2 2>&1 | grep -v -i warn
cp data/model_final.json src/coach/model.json
npx tsx sim/equity.ts data/model_final.json 60000
npx tsx sim/lv.ts data/model_final.json 5000 strong simple 11 &
npx tsx sim/lv.ts data/model_final.json 5000 strong heur 12 &
wait
npx tsx sim/lv.ts data/model_final.json 1500 expert simple 13 &
npx tsx sim/lv.ts data/model_final.json 1500 expert data/model_final.json 14 &
wait
npx tsx sim/vs.ts 5000
