#!/usr/bin/env bash
# Compare ringwire with node:http (and Bun, if installed) using oha.
#   npm run build && bench/run.sh            # DURATION=10s CONNS=256 to tweak
set -euo pipefail
cd "$(dirname "$0")"

DURATION=${DURATION:-10s}
CONNS=${CONNS:-256}
command -v oha >/dev/null || { echo "needs oha: cargo install oha"; exit 1; }

pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null || true; }
trap cleanup EXIT

start() { # name port cmd...
  local port=$2; shift 2
  PORT=$port "$@" >/dev/null 2>&1 & pids+=($!)
}

start node      4101 node servers/node-http.js
start ringwire1 4102 env THREADS=1 node servers/ringwire.js
start ringwire2 4103 env THREADS=2 node servers/ringwire.js
command -v bun >/dev/null && start bun 4104 bun servers/bun.js
sleep 1

bench() { # label port path
  oha -z "$DURATION" -c "$CONNS" --no-tui "http://127.0.0.1:$2$3" |
    awk -v n="$1" '/Requests\/sec/{r=$2} /99.00%/{p=$3} /Success rate/{s=$3}
      END{printf "| %-22s | %12.0f | %8.2f ms | %s |\n", n, r, p, s}'
}

echo "oha -z $DURATION -c $CONNS, $(nproc) cores, $(uname -r), node $(node -v)"
for path in /plaintext /json; do
  echo
  echo "### $path"
  echo "| server                 |        req/s |        p99 | ok      |"
  echo "|------------------------|-------------:|-----------:|---------|"
  bench "node:http"            4101 "$path"
  command -v bun >/dev/null && bench "Bun.serve ($(bun -v))" 4104 "$path"
  bench "ringwire (1 thread)"  4102 "$path"
  bench "ringwire (2 threads)" 4103 "$path"
done
