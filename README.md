# FORGE

**Banking infrastructure. Onchain.**

Open source developer sandbox for traditional-bank workflows on Solana. The Anchor program implements vault creation/funding, the milestone 2 loan lifecycle and dual-approver withdrawals. A TypeScript SDK, a keyless orchestration API with a reconciling worker, and an operator console exercise the full flow on a disposable loopback validator. It is not a banking service, audited protocol, or production-ready custody system.

## Implemented boundary

- One Anchor program: `create_vault`, `fund_vault`, `propose_loan`, `approve_loan`, `draw_loan`, `repay_loan`, `propose_withdrawal`, `approve_withdrawal`, `set_disbursement_paused`.
- Treasury signs creation and funding. Two distinct approver public keys, limits, mint and treasury destination are recorded immutably.
- Vault PDA: `["vault", treasury, 32-byte vault ID]`. Its legacy SPL token account uses `["tokens", vault]`; SPL Token owns that account, while the vault PDA is its transfer authority. Loans use `["loan", vault, loan_id]`; withdrawals use `["withdrawal", vault, withdrawal_id]`.
- Treasury explicitly selects a six-decimal legacy mint at creation. That address is fixed for the vault, not a global issuer allowlist or proof of bank identity. Wrong mints, owners, token programs and cross-vault account substitutions fail.
- Funding uses checked integer token transfers. The fixture funds **10,000 FORGE_TEST_USD = 10,000,000,000 base units**.

Loan terms are fixed at proposal, require two distinct approver approvals, and can be drawn once by the designated borrower. Repayment collects the fixed payoff. Withdrawals are proposed by one approver and execute when the other approves; `withdrawal_id` makes replays fail instead of moving funds twice. Pause changes carry the vault's `pause_seq`, so a delayed stale request cannot undo a newer one. This is still a local prototype; never fund it with assets of real value.

Architecture decisions: [ADR 0001 TypeScript backend](docs/adr/0001-typescript-backend.md), [ADR 0002 keyless orchestration](docs/adr/0002-keyless-orchestration.md), [ADR 0003 program idempotency](docs/adr/0003-program-idempotency.md).

## Bun + Nx workspace

| Path | Nx project | Current scope |
| --- | --- | --- |
| `programs/forge` | `onchain` | Anchor program and LiteSVM tests. |
| `packages/sdk` | `@forge/sdk` | IDL-driven `@solana/kit` builders, plans, signer-side verification, decoders, error classification and loan views. |
| `apps/api` | `@forge/api` | Bun API (`api`) and worker (`worker`) sharing only PostgreSQL. Holds no keys. |
| `apps/console` | `@forge/console` | Operator console: plan review, local demo signing, settlement, statement. |
| `apps/localnet` | `@forge/localnet` | Fixture seeding and end-to-end validation against a loopback validator. |
| `apps/site` | `@forge/site` | Landing page and Fumadocs documentation; static export to GitHub Pages. |
| `packages/config` | `@forge/config` | Shared TypeScript configuration. |

```sh
nix-shell
bun install --frozen-lockfile
npx nx run-many -t build
npx nx run-many -t check-types test
bun run check
```

Use `--parallel=1` on build/check commands on memory-constrained machines. API tests need the local PostgreSQL (`scripts/localnet.sh pg-up`).

### Local stack

Everything binds to loopback where the tools allow it and keeps state under the ignored `.local/` directory. The validator loads the built program at genesis; nothing is deployed to Devnet or mainnet.

```sh
nix-shell --run 'bash scripts/build.sh'           # program + IDL
nix-shell --run 'bash scripts/localnet.sh up'      # PostgreSQL :54329 + solana-test-validator :8899
bun run --cwd packages/sdk build
bun run --cwd apps/localnet seed                   # demo wallets, mint, institutions → .local/demo/session.json
bun run dev:api                                    # API :3002 + worker
bun run dev:console                                # console http://127.0.0.1:3003
bun run e2e                                        # scripted validation (own database and API port)
nix-shell --run 'bash scripts/localnet.sh down'    # or `reset` to delete all local state
```

For a long-running demo, `nix-shell --run 'bash scripts/demo.sh up'` starts all of the above as `systemd --user` services on a fresh chain with seeded wallets (`status`, `down`; logs via `journalctl --user -u forge-demo-api`). Everything stays on loopback; use it from another machine through an SSH tunnel:

```sh
ssh -N -L 3003:127.0.0.1:3003 <user>@<host>   # then open http://localhost:3003
# optional: add -L 3002:127.0.0.1:3002 for the API, -L 8899:127.0.0.1:8899 -L 8900:127.0.0.1:8900 for RPC
```

`solana-test-validator` 4.0.3 binds RPC, websocket and faucet to all interfaces and has no option to restrict them; keep a host firewall in place (the tested NixOS host's default firewall blocks inbound connections).

The API never receives a private key. Demo wallets live only in `.local/demo/session.json` and in the signer processes: the e2e script, or the console tab acting as each role's wallet.

SDK build depends on the Anchor build, copies only public IDL/types into ignored `packages/sdk/src/generated/`, and emits JavaScript, declarations and JSON under `dist/`. Never edit or commit those generated copies. Nx caches public program outputs, not generated keypairs; Nx Cloud is disabled.

The scaffold came from Better-T-Stack **3.44.0**, generated in `.cache/` and integrated without replacing existing Git/Cargo files. `bts.jsonc` records generator choices; the generated web/native starters, shared UI package and Go service have since been removed (ADR 0001). `bun.lock` locks dependencies. Requested addons are configured: Nx, Oxlint/Ultracite, project-local MCP (`.mcp.json`: Nx and Next DevTools), and local React/Expo skills (`.agents/skills`, `skills-lock.json`). MCP configuration is not an automatically running server. No global agent settings were changed.

Static graph export:

```sh
npx nx graph --file=.cache/nx/project-graph.html
```

## Rust build and test without deployment

Tested platform: Nix on x86_64 Linux. `flake.lock` pins Anchor 1.2.0, Solana CLI 4.0.3 and host tools. `shell.nix` uses that same lock and also works before the initial Git commit. The development shell pins `NIX_PATH` to this locked source, including the SBF builder's nested NixOS dependency lookup. On NixOS, the downloaded upstream platform-tools executables require `nix-ld` support; the tested host already provides it. This repository does not change system or Home Manager configuration.

```sh
nix-shell
bash scripts/check-nix-path.sh
bash scripts/bootstrap.sh
bash scripts/build.sh
cargo test --locked -p forge
cargo fmt --all -- --check
cargo clippy --locked -p forge --all-targets -- -D warnings
```

Bootstrap installs the separately published `cargo-build-sbf` **4.3.0** under ignored `.tools/`, never over the host-managed Rust installation. The build script downloads platform-tools **v1.57** under `.tools/home/`, uses its Rust compiler, compiles SBPF v0 for the pinned LiteSVM runtime, and generates `target/deploy/forge.so`, `target/idl/forge.json` and `target/types/forge.ts`. First setup requires network access and several GB of disk space. Subsequent commands use the pinned lockfiles and caches.

Always rebuild before running Rust tests after program changes: the tests execute `target/deploy/forge.so`, not a substitute native handler. LiteSVM 0.10.0 verifies signed transactions and executes the actual compiled program plus SPL Token CPIs. The suite checks exact balances and ownership, invalid configuration, absent or forged signatures, cross-vault isolation, Token-2022 rejection, duplicate IDs, zero/insufficient funding and direct SPL theft attempts.

### Reproducible local demonstration

After building, run the in-process fixture:

```sh
cargo test --locked -p forge --test vault create_and_fund_exact_test_token_balance -- --exact --nocapture
```

It creates independent treasury and two approver wallets, issues the disclosed test supply, creates the vault and funds it. Output contains only public role identities, the configured mint, vault/token-account addresses, the funding signature and integer balances. Expected treasury cash: `0`; vault cash: `10000000000`. Wallets are random and held only in memory; addresses and signatures change each run, while the accounting assertions remain reproducible. The signature is an in-process test receipt, not a finalized network transaction or explorer link.

`apps/localnet` now seeds a loopback validator (`bun run --cwd apps/localnet seed`) and runs the end-to-end flow (`bun run e2e`); see [docs/validation.md](docs/validation.md) for recorded evidence.

**LiteSVM is not a local validator.** Program tests run in LiteSVM; the service flow runs against `solana-test-validator` on loopback. Do not run `anchor test` as a deployment-free test command: it automatically deploys. Devnet and mainnet deployment remain unapproved.

## Trust and operational limits

- `FORGE_TEST_USD` is a fixture label, not token metadata, redeemable currency, certified security or transferable loan instrument. Fixtures issue test supply explicitly; funding does not mint tokens. The fixture treasury retains mint authority and can issue additional test tokens. The mint has no freeze authority.
- Fixtures use independently generated demonstration treasury and approver wallets held only in memory. No real bank/customer data is required. Generated build keys stay under ignored `target/` and must never be reused outside disposable local testing.
- Creating a vault does not certify a bank, and the rules restrict FORGE instructions, not every transfer of the token. Direct token donations can increase cash; they do not allocate repayment or alter loan state.
- The program is only ever loaded at genesis of a disposable loopback validator; there is no Devnet/mainnet deployment or established upgrade authority. If deployed with the upgradeable loader later, the chosen deployment wallet retains upgrade control unless explicitly changed. The prototype must not claim the deployer has no control. `Anchor.toml` names the demonstration treasury wallet by default; deployment authority selection must be recorded at that approved step.
- Builds preserve the declared test program ID using `--ignore-keys`. Generated program keypairs are local artifacts, not portable deployment identities; verify/synchronize the chosen ID and keypair during an approved deployment workflow.
- The API, worker and console are a prototype: no production custody, no real bank integration, demo API keys and webhook secrets, and browser-held demo keys in the console.

See [validation evidence and remaining gates](docs/validation.md), [product specification](docs/FORGE-MVP-v0.1.md), and [implementation plan](docs/plans/2026-09-16-vault.md).

## Brand and licensing

[DESIGN.md](DESIGN.md) and [docs/brand/](docs/brand/) preserve the supplied visual identity. Logo concepts and HTML are references, not a working operator interface or finalized vector mark. Generated starter screens are not branded banking interfaces.

Application source is proprietary; no open-source license is granted. The MIT notice in `docs/brand/REFERENCE-LICENSE.txt` applies to the referenced brand collection, not the application. Dependency licenses remain their own.
