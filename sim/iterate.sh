#!/bin/bash
# One round of policy iteration: sim/iterate.sh <prevModel> <newTag> <hands per process>
set -e
prev=$1; tag=$2; n=${3:-40000}
npx tsx sim/gen.ts ${tag}_1 $n $((RANDOM)) $prev 0.2 &
npx tsx sim/gen.ts ${tag}_2 $n $((RANDOM)) $prev 0.2 &
wait
python3 sim/train.py data/model_${tag}.json ${tag}_1 ${tag}_2
npx tsx sim/lv.ts data/model_${tag}.json 2500 strong simple
npx tsx sim/lv.ts data/model_${tag}.json 2500 strong $prev
