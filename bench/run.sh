#!/usr/bin/env bash
# Compare ringwire with node:http, uWebSockets.js and Bun using oha.
#   npm run build && bench/run.sh
#   DURATION=10s CONNS=256 NODE=/path/to/node bench/run.sh
#   SERVER_CPUS=11 CLIENT_CPUS=0-9 bench/run.sh   # pin each server to one core
# uWebSockets.js is optional: `cd bench && npm install` (needs Node 22+).
set -euo pipefail
cd "$(dirname "$0")"

DURATION=${DURATION:-10s}
CONNS=${CONNS:-256}
NODE=${NODE:-node}
SERVER_CPUS=${SERVER_CPUS:-}
CLIENT_CPUS=${CLIENT_CPUS:-}
pin() { # cpus cmd...
  local cpus=$1; shift
  if [ -n "$cpus" ]; then taskset -c "$cpus" "$@"; else "$@"; fi
}
command -v oha >/dev/null || { echo "needs oha: cargo install oha"; exit 1; }

have_uws() { [ -d node_modules/uWebSockets.js ] && "$NODE" -e "require('uWebSockets.js')" 2>/dev/null; }

pids=()
declare -A pid_of
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

start() { # port cmd...
  local port=$1; shift
  # exec so that $! is the server itself (taskset and env exec too).
  (
    export PORT=$port
    if [ -n "$SERVER_CPUS" ]; then exec taskset -c "$SERVER_CPUS" "$@"; else exec "$@"; fi
  ) >/dev/null 2>&1 &
  pids+=($!)
  pid_of[$port]=$!
}

# CPU seconds (user + system, all threads) used so far by a process.
cpu_seconds() {
  awk -v hz="$(getconf CLK_TCK)" '{ sub(/^.*\) /, ""); print ($12 + $13) / hz }' "/proc/$1/stat"
}

start 4101 "$NODE" servers/node-http.js
start 4102 env THREADS=1 "$NODE" servers/ringwire.js
start 4103 env THREADS=2 "$NODE" servers/ringwire.js
have_uws && start 4105 "$NODE" servers/uws.js
command -v bun >/dev/null && start 4104 bun servers/bun.js
sleep 1

# One row: throughput, p99 latency, CPU cores the server used, and
# efficiency (requests per CPU-second, i.e. throughput per core).
bench() { # label port path
  local pid=${pid_of[$2]} before after secs
  before=$(cpu_seconds "$pid")
  local out
  out=$(pin "$CLIENT_CPUS" oha -z "$DURATION" -c "$CONNS" --no-tui "http://127.0.0.1:$2$3")
  after=$(cpu_seconds "$pid")
  secs=${DURATION%s}
  echo "$out" | awk -v n="$1" -v cpu="$(awk -v a="$after" -v b="$before" 'BEGIN { print a - b }')" -v secs="$secs" '
    /Requests\/sec/{r=$2} /99.00%/{p=$3} /Success rate/{s=$3}
    END{printf "| %-26s | %9.0f | %7.2f ms | %5.2f | %9.0f | %s |\n", n, r, p, cpu/secs, r*secs/cpu, s}'
}

echo "oha -z $DURATION -c $CONNS, $(nproc) cores, $(uname -r), node $("$NODE" -v)${SERVER_CPUS:+, servers pinned to CPU $SERVER_CPUS}"
for path in /plaintext /json; do
  echo
  echo "### $path"
  echo "| server                     |     req/s |        p99 | cores | req/CPU-s | ok      |"
  echo "|----------------------------|----------:|-----------:|------:|----------:|---------|"
  bench "node:http"                4101 "$path"
  command -v bun >/dev/null && bench "Bun.serve ($(bun -v))" 4104 "$path"
  have_uws && bench "uWebSockets.js" 4105 "$path"
  bench "ringwire (1 thread)"      4102 "$path"
  bench "ringwire (2 threads)"     4103 "$path"
done
