#!/usr/bin/env bash
# Disposable loopback stack for development and end-to-end tests.
# Run inside the pinned shell: nix-shell --run 'bash scripts/localnet.sh up'
# State lives under the ignored .local/ directory; `reset` deletes it.
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="$PWD/.local/localnet"
PG_DATA="$STATE/pg"
PG_PORT="${FORGE_PG_PORT:-54329}"
RPC_PORT="${FORGE_RPC_PORT:-8899}"
LEDGER="$STATE/ledger"
PROGRAM_ID="$(jq -r .address target/idl/forge.json)"

pg_up() {
	mkdir -p "$STATE"
	if [[ ! -d "$PG_DATA" ]]; then
		initdb --pgdata="$PG_DATA" --username=forge --auth=trust --no-locale --encoding=UTF8 >/dev/null
	fi
	if ! pg_ctl --pgdata="$PG_DATA" status >/dev/null 2>&1; then
		pg_ctl --pgdata="$PG_DATA" --log="$STATE/pg.log" --wait \
			-o "-c listen_addresses=127.0.0.1 -p $PG_PORT -k $STATE" start >/dev/null
	fi
	for db in forge forge_test; do
		psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -tAc \
			"SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1 ||
			psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -qc "CREATE DATABASE $db"
	done
	echo "postgres: postgres://forge@127.0.0.1:$PG_PORT/forge"
}

pg_down() {
	if [[ -d "$PG_DATA" ]] && pg_ctl --pgdata="$PG_DATA" status >/dev/null 2>&1; then
		pg_ctl --pgdata="$PG_DATA" --wait stop >/dev/null
	fi
}

validator_up() {
	[[ -f target/deploy/forge.so ]] || {
		echo "build the program first: bash scripts/build.sh" >&2
		exit 1
	}
	mkdir -p "$STATE"
	if [[ -f "$STATE/validator.pid" ]] && kill -0 "$(cat "$STATE/validator.pid")" 2>/dev/null; then
		echo "validator: already running"
		return
	fi
	# Genesis-loaded program: a disposable loopback ledger, never Devnet or mainnet.
	# The default ledger limit (10,000 shreds ≈ 11 minutes here) purges history the indexer
	# cursors and expiry proofs rely on; keep enough for long sessions.
	solana-test-validator --reset --quiet --ledger "$LEDGER" --limit-ledger-size 50000000 \
		--bind-address 127.0.0.1 --rpc-port "$RPC_PORT" \
		--faucet-port "$((RPC_PORT + 1001))" \
		--bpf-program "$PROGRAM_ID" target/deploy/forge.so \
		>"$STATE/validator.log" 2>&1 &
	echo $! >"$STATE/validator.pid"
	for _ in $(seq 1 60); do
		if curl -sf -X POST -H 'content-type: application/json' \
			-d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$RPC_PORT" | grep -q ok; then
			echo "validator: http://127.0.0.1:$RPC_PORT (program $PROGRAM_ID)"
			return
		fi
		sleep 1
	done
	echo "validator did not become healthy; see $STATE/validator.log" >&2
	exit 1
}

validator_down() {
	if [[ -f "$STATE/validator.pid" ]]; then
		kill "$(cat "$STATE/validator.pid")" 2>/dev/null || true
		rm -f "$STATE/validator.pid"
	fi
}

case "${1:-}" in
up)
	pg_up
	validator_up
	;;
down)
	validator_down
	pg_down
	;;
pg-up) pg_up ;;
pg-down) pg_down ;;
validator-up) validator_up ;;
validator-down) validator_down ;;
reset)
	validator_down
	pg_down
	rm -rf "$STATE"
	;;
*)
	echo "usage: $0 {up|down|pg-up|pg-down|validator-up|validator-down|reset}" >&2
	exit 2
	;;
esac
