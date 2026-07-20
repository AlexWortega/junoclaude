#!/usr/bin/env bash
# Runs the orbital insertion N times and reports how many reached orbit.
#
# One flight proves a trajectory is possible; only a run of them proves the
# procedure works. A single success out of four was what stopped the previous
# attempt from counting as done.
set -u
cd "$(dirname "$0")/.."

craft="${1:-JC-Orbit-03}"
runs="${2:-3}"

for i in $(seq 1 "$runs"); do
  echo "=== run $i/$runs ==="
  JUNO_TARGET_APOAPSIS="${JUNO_TARGET_APOAPSIS:-200000}" \
    node scripts/fly.mjs "$craft" "DSC Large Pad" 800 2>&1 | tail -5
done

echo
node scripts/orbit-summary.mjs "$(echo "$craft" | tr - _)-"
