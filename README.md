# FORGE

**Banking infrastructure. Onchain.**

Open source developer sandbox for traditional-bank workflows on Solana. On-chain functionality implements vault creation/funding and the **milestone 2 loan lifecycle**. The Bun/Nx workspace also contains a health-only Go service and an IDL-only SDK foundation. It is not a banking service, audited protocol, or production-ready custody system.

## Implemented boundary

- One Anchor program; vault creation/funding plus propose, approve, draw, repay, withdrawal and disbursement pause instructions.
- Treasury signs creation and funding. Two distinct approver public keys, limits, mint and treasury destination are recorded immutably.
- Vault PDA: `["vault", treasury, 32-byte vault ID]`. Its legacy SPL token account uses `["tokens", vault]`; SPL Token owns that account, while the vault PDA is its transfer authority.
- Treasury explicitly selects a six-decimal legacy mint at creation. That address is fixed for the vault, not a global issuer allowlist or proof of bank identity. Wrong mints, owners, token programs and cross-vault account substitutions fail.
- Funding uses checked integer token transfers. The fixture funds **10,000 FORGE_TEST_USD = 10,000,000,000 base units**.

Loan terms are fixed at proposal, require two distinct approver approvals, and can be drawn once by the designated borrower. Repayment collects the fixed payoff, while withdrawal only transfers actual vault cash and requires both approvers. This is still a local prototype; never fund it with assets of real value.

## Bun + Nx workspace

| Path | Nx project | Current scope |
| --- | --- | --- |
| `services/banking` | `banking` | Go standard-library service; `GET /health` on `127.0.0.1:3002`. |
| `apps/site` | `@forge/site` | Landing page and Fumadocs documentation; static export to GitHub Pages. |
| `packages/sdk` | `@forge/sdk` | Public IDL, generated `Forge` type and `FORGE_PROGRAM_ID`; no transaction builders. |
| `programs/forge` | `onchain` | Existing Rust/Anchor vault program, unchanged. |
| `packages/config` | `@forge/config` | Shared TypeScript configuration. |

These workspace choices supersede the proposed Vite/single-service layout in the earlier MVP specification; financial milestones and deployment gates remain unchanged. The banking service has no financial endpoints, persistence, authentication, payments, keys or bank integration. Health reports process liveness only.

```sh
nix-shell
bun install --frozen-lockfile
npx nx run-many -t build
npx nx run-many -t check-types test
bun run check
npx nx graph
```

Use `--parallel=1` on build/check commands on memory-constrained machines. Three projects have build targets (`onchain`, `@forge/sdk`, `banking`); config has no build output.

```sh
bun run dev:banking
bun run dev:site
```

Banking accepts `BANKING_ADDR` and binds to loopback by default. No Go-to-chain integration is claimed. Actual graph edges include `@forge/sdk -> onchain`; Go remains independent until an integration exists.

SDK build depends on the Anchor build, copies only public IDL/types into ignored `packages/sdk/src/generated/`, and emits JavaScript, declarations and JSON under `dist/`. Never edit or commit those generated copies. Nx caches public program outputs, not generated keypairs; Nx Cloud is disabled.

The scaffold came from Better-T-Stack **3.44.0**, generated in `.cache/` and integrated without replacing existing Git/Cargo files. `bts.jsonc` records generator choices, not the separately added Go service; the generated web/native starters and shared UI package have since been removed. `bun.lock` locks dependencies. Requested addons are configured: Nx, Oxlint/Ultracite, project-local MCP (`.mcp.json`: Nx and Next DevTools), and local React/Expo skills (`.agents/skills`, `skills-lock.json`). MCP configuration is not an automatically running server. No global agent settings were changed.

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

A network seed CLI is deferred until the local-validator deployment step is explicitly approved. The workspace SDK packages the generated IDL and TypeScript type, but milestone 3's transaction builders and integration workflow are not implemented.

**LiteSVM is not a local validator.** No deployment or local-validator acceptance is claimed. Do not run `anchor test` as a deployment-free test command: it automatically deploys. Local-validator deployment/test execution requires separate explicit approval.

## Trust and operational limits

- `FORGE_TEST_USD` is a fixture label, not token metadata, redeemable currency, certified security or transferable loan instrument. Fixtures issue test supply explicitly; funding does not mint tokens. The fixture treasury retains mint authority and can issue additional test tokens. The mint has no freeze authority.
- Fixtures use independently generated demonstration treasury and approver wallets held only in memory. No real bank/customer data is required. Generated build keys stay under ignored `target/` and must never be reused outside disposable local testing.
- Creating a vault does not certify a bank, and the rules restrict FORGE instructions, not every transfer of the token. Direct token donations can increase cash; they do not allocate repayment or alter loan state.
- There is no deployed program or established upgrade authority in this checkout. If deployed with the upgradeable loader later, the chosen deployment wallet retains upgrade control unless explicitly changed. The prototype must not claim the deployer has no control. `Anchor.toml` names the demonstration treasury wallet by default; deployment authority selection must be recorded at that approved step.
- Builds preserve the declared test program ID using `--ignore-keys`. Generated program keypairs are local artifacts, not portable deployment identities; verify/synchronize the chosen ID and keypair during an approved deployment workflow.
- Application/service scaffolds and SDK metadata do not implement a banking API, database, borrower wallet or operational dashboard.

See [validation evidence and remaining gates](docs/validation.md), [product specification](docs/FORGE-MVP-v0.1.md), and [implementation plan](docs/plans/2026-09-16-vault.md).

## Brand and licensing

[DESIGN.md](DESIGN.md) and [docs/brand/](docs/brand/) preserve the supplied visual identity. Logo concepts and HTML are references, not a working operator interface or finalized vector mark. Generated starter screens are not branded banking interfaces.

Application source is proprietary; no open-source license is granted. The MIT notice in `docs/brand/REFERENCE-LICENSE.txt` applies to the referenced brand collection, not the application. Dependency licenses remain their own.
