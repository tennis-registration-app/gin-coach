#!/bin/bash
# Retrain the coach after a rule change: sim/retrain.sh  (about 35 minutes on two cores)
set -e
mkdir -p data
prev=src/coach/model.json
for r in 1 2 3; do
  npx tsx sim/gen.ts r${r}_1 45000 $((RANDOM)) $prev 0.2 &
  npx tsx sim/gen.ts r${r}_2 45000 $((RANDOM)) $prev 0.2 &
  wait
  python3 sim/train.py data/model_r${r}.json r${r}_1 r${r}_2 2>&1 | grep -v -i warn
  npx tsx sim/lv.ts data/model_r${r}.json 2500 strong simple
  prev=data/model_r${r}.json
done
python3 sim/train.py data/model_new.json r2_1 r2_2 r3_1 r3_2 2>&1 | grep -v -i warn
npx tsx sim/lv.ts data/model_new.json 2500 strong data/model_r3.json
cp data/model_new.json src/coach/model.json
npx tsx sim/equity.ts src/coach/model.json 60000
npx tsx sim/lv.ts src/coach/model.json 5000 strong simple 11 &
npx tsx sim/lv.ts src/coach/model.json 5000 strong heur 12 &
wait
npx tsx sim/lv.ts src/coach/model.json 1500 expert simple 13 &
npx tsx sim/lv.ts src/coach/model.json 1500 expert src/coach/model.json 14 &
wait
npx tsx sim/vs.ts 5000
echo RETRAIN_DONE
