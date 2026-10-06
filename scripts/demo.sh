#!/usr/bin/env bash
# Long-running local demo: PostgreSQL, a disposable validator, the API, the worker and the
# console as transient systemd --user services (they survive the launching shell and logout
# when lingering is enabled). Everything binds to 127.0.0.1; reach it through an SSH tunnel.
#
#   nix-shell --run 'bash scripts/demo.sh up'      # fresh chain, fresh database, demo wallets
#   bash scripts/demo.sh status
#   bash scripts/demo.sh down
#   journalctl --user -u forge-demo-api -f        # logs (also: -worker, -console, -validator, -pg)
set -euo pipefail
cd "$(dirname "$0")/.."

STATE="$PWD/.local/localnet"
PG_DATA="$STATE/pg"
PG_PORT="${FORGE_PG_PORT:-54329}"
RPC_PORT="${FORGE_RPC_PORT:-8899}"
API_PORT="${FORGE_API_PORT:-3002}"
CONSOLE_PORT="${FORGE_CONSOLE_PORT:-3003}"
DATABASE_URL="postgres://forge@127.0.0.1:$PG_PORT/forge"
UNITS=(forge-demo-console forge-demo-worker forge-demo-api forge-demo-validator forge-demo-pg)

wait_for() {
	local label=$1
	shift
	for _ in $(seq 1 90); do
		if "$@" >/dev/null 2>&1; then
			echo "  ✔ $label"
			return
		fi
		sleep 1
	done
	echo "  ✘ $label did not come up; see: journalctl --user -u forge-demo-*" >&2
	exit 1
}

service() {
	local unit=$1
	shift
	systemctl --user stop "$unit" >/dev/null 2>&1 || true
	systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
	systemd-run --user --quiet --collect --unit="$unit" \
		--property=WorkingDirectory="$PWD" --setenv=HOME="$HOME" "$@"
}

rpc_healthy() {
	curl -sf -X POST -H 'content-type: application/json' \
		-d '{"jsonrpc":"2.0","id":1,"method":"getHealth"}' "http://127.0.0.1:$RPC_PORT" | grep -q ok
}

up() {
	for tool in postgres initdb psql solana-test-validator bun jq curl systemd-run; do
		command -v "$tool" >/dev/null || {
			echo "missing $tool; run inside: nix-shell --run 'bash scripts/demo.sh up'" >&2
			exit 1
		}
	done
	[[ -f target/deploy/forge.so ]] || bash scripts/build.sh
	# Script-managed instances from scripts/localnet.sh would hold the same ports.
	bash scripts/localnet.sh down >/dev/null 2>&1 || true
	down >/dev/null 2>&1 || true
	mkdir -p "$STATE" "$PWD/.local/demo"

	echo "Starting FORGE demo (loopback only)"
	[[ -d "$PG_DATA" ]] || initdb --pgdata="$PG_DATA" --username=forge --auth=trust --no-locale --encoding=UTF8 >/dev/null
	service forge-demo-pg "$(command -v postgres)" -D "$PG_DATA" \
		-c listen_addresses=127.0.0.1 -p "$PG_PORT" -k "$STATE"
	wait_for "PostgreSQL :$PG_PORT" psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -tAc 'SELECT 1'

	# A fresh chain needs a fresh application database.
	psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -q \
		-c "DROP DATABASE IF EXISTS forge WITH (FORCE)" -c "CREATE DATABASE forge"
	psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -tAc \
		"SELECT 1 FROM pg_database WHERE datname = 'forge_test'" | grep -q 1 ||
		psql -h 127.0.0.1 -p "$PG_PORT" -U forge -d postgres -qc "CREATE DATABASE forge_test"

	service forge-demo-validator "$(command -v solana-test-validator)" --reset --quiet \
		--ledger "$STATE/ledger" --limit-ledger-size "${FORGE_LEDGER_SHREDS:-500000}" \
		--bind-address 127.0.0.1 --rpc-port "$RPC_PORT" --faucet-port "$((RPC_PORT + 1001))" \
		--bpf-program "$(jq -r .address target/idl/forge.json)" target/deploy/forge.so
	wait_for "validator :$RPC_PORT (program at genesis)" rpc_healthy

	(cd packages/sdk && bun run build >/dev/null)
	echo "  ✔ SDK built"
	FORGE_DATABASE_URL="$DATABASE_URL" bun apps/api/src/cli.ts migrate >/dev/null
	FORGE_DATABASE_URL="$DATABASE_URL" FORGE_RPC_URL="http://127.0.0.1:$RPC_PORT" \
		FORGE_API_URL="http://127.0.0.1:$API_PORT" bun apps/localnet/src/seed.ts >/dev/null
	echo "  ✔ demo wallets, FORGE_TEST_USD mint and institutions seeded"

	local env=(--setenv=FORGE_DATABASE_URL="$DATABASE_URL" --setenv=FORGE_RPC_URL="http://127.0.0.1:$RPC_PORT"
		--setenv=FORGE_NETWORK=localnet --setenv=FORGE_API_ADDR="127.0.0.1:$API_PORT")
	service forge-demo-api "${env[@]}" "$(command -v bun)" apps/api/src/main.ts api
	service forge-demo-worker "${env[@]}" --setenv=FORGE_WORKER_ID=demo-worker --setenv=FORGE_WORKER_TICK_MS=500 \
		"$(command -v bun)" apps/api/src/main.ts worker
	service forge-demo-console --setenv=FORGE_API_URL="http://127.0.0.1:$API_PORT" \
		--setenv=FORGE_CONSOLE_PORT="$CONSOLE_PORT" "$(command -v bun)" apps/console/server.ts
	wait_for "API :$API_PORT" curl -sf "http://127.0.0.1:$API_PORT/health"
	wait_for "console :$CONSOLE_PORT" curl -sf "http://127.0.0.1:$CONSOLE_PORT/dev/session"
	status
}

down() {
	for unit in "${UNITS[@]}"; do
		systemctl --user stop "$unit" >/dev/null 2>&1 || true
		systemctl --user reset-failed "$unit" >/dev/null 2>&1 || true
	done
	echo "FORGE demo stopped (state kept in .local/; 'bash scripts/localnet.sh reset' deletes it)"
}

status() {
	echo
	for unit in "${UNITS[@]}"; do
		printf '  %-22s %s\n' "$unit" "$(systemctl --user is-active "$unit" 2>/dev/null || true)"
	done
	echo
	printf '  %-8s %-24s %s\n' Console "http://127.0.0.1:$CONSOLE_PORT" "(proxies /v1 to the API)"
	printf '  %-8s %-24s %s\n' API "http://127.0.0.1:$API_PORT" "(key in .local/demo/session.json)"
	printf '  %-8s %-24s %s\n' RPC "http://127.0.0.1:$RPC_PORT" "(websocket :$((RPC_PORT + 1)))"
	echo
	echo "  From another machine: ssh -N -L $CONSOLE_PORT:127.0.0.1:$CONSOLE_PORT $(whoami)@<this-host>"
	echo "  then open http://localhost:$CONSOLE_PORT"
}

case "${1:-}" in
up) up ;;
down) down ;;
status) status ;;
*)
	echo "usage: $0 {up|down|status}" >&2
	exit 2
	;;
esac
