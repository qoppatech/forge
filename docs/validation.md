# Milestone 1 validation — 16 September 2026

## Status

Compiled-program creation, funding and authorization checks pass in LiteSVM. **Milestone 1's local-validator exit criterion remains unpassed and deployment remains unapproved.** No local or remote deployment, validator reset, push or commit has been performed in this writer pass. Independent security review found no local-sandbox blocker; accepted reproducibility and disclosure findings are addressed below.

## Observed versions

| Component | Version |
| --- | --- |
| Anchor CLI, `anchor-lang`, `anchor-spl` | 1.2.0 |
| Solana CLI (Nix package) | 4.0.3 |
| Host Rust / Cargo in pinned Nix shell | 1.98.1 / 1.98.0 |
| `cargo-build-sbf` | 4.3.0 |
| Platform tools | v1.57 |
| Platform Rust / Cargo | 1.95.0-dev (ae660768a, 2026-08-17) / 1.95.0 |
| LiteSVM | 0.10.0 |

Anchor's [versioned generated template](https://github.com/otter-sec/anchor/blob/v1.2.0/cli/src/template.rs) was inspected before choosing dependencies. Primary references: [Anchor 1.2.0 release](https://github.com/otter-sec/anchor/releases/tag/v1.2.0), [TypeScript compatibility](https://www.anchor-lang.com/docs/clients/typescript), [SBF builder](https://github.com/anza-xyz/cargo-build-sbf). `Cargo.lock` and `flake.lock` record exact retained dependency/tool resolution; no floating toolchain claim is made.

## Rust results

Commands below run from the repository root. Build and test commands use `nix-shell --run '…'`.

| Command | Observed result |
| --- | --- |
| `cargo test --locked -p forge --test vault` before feature correction | Failed at compilation: Anchor init macro referenced disabled `token_2022` / `token_interface`. |
| `bash scripts/build.sh && cargo test --locked -p forge --test vault` after correction | SBF and IDL generation passed; original 9 runtime tests passed. |
| `cargo test --locked -p forge --test vault token_2022` | Passed real Token-2022 mint-owner substitution rejection. |
| `cargo test --locked -p forge --test vault unexpected_token_program` | Passed system-program and Token-2022 program substitution rejection on both instructions. |
| `cargo test --locked -p forge --test vault create_and_fund_exact_test_token_balance -- --exact --nocapture` | Passed; printed only public fixture identities, mint, in-process funding signature and balances: treasury `0`, vault `10000000000` base units. |
| `bash scripts/build.sh && cargo test --locked -p forge` | Passed rebuild, IDL generation and all 10 runtime tests; no ignored tests. |
| `cargo check --locked -p forge --all-targets` | Passed. |
| `cargo fmt --all -- --check` | Passed. |
| `cargo clippy --locked -p forge --all-targets -- -D warnings` | Passed after a test-only lint allowance retaining LiteSVM's public large-error result type and full failure logs. |
| `git diff --check` and `git diff --cached --check` | Passed; nothing staged (new files are untracked). |
| Per-file `git diff --no-index --check /dev/null <file>` | Authored source/config/docs clean. Supplied `docs/brand/REFERENCE-LICENSE.txt:22` reports one existing blank line at EOF; retained to preserve byte-identical source. |
| Byte comparison against supplied spec/brand directory | All 7 brand files and product specification unchanged. |
| `bash scripts/bootstrap.sh` | Passed against installed project-local builder 4.3.0; no host installation overwritten. |
| `bash -n scripts/build.sh scripts/bootstrap.sh` | Passed. |

Anchor 1.2.0's `init` token-account macro unconditionally emits `anchor_spl::token_interface` calls and Token-2022-aware space calculation. Enabling `anchor-spl/token_2022` is necessary even for legacy initialization. This does **not** relax the program's `Program<Token>` ID check or `Account<Mint/TokenAccount>` owner checks. Real Token-2022 rejection tests verify that boundary.

### Negative-control evidence

Original preimplementation red output was not retained across the previous writer timeout; no original TDD success is claimed. A fresh mutation check temporarily removed the zero-funding guard, rebuilt the actual SBF, and ran:

```sh
nix-shell --run 'bash scripts/build.sh && cargo test --locked -p forge --test vault funding_rejects_wrong_mint_source_owner_and_amounts'
```

It failed with `invalid direct call must fail`: the real SPL `TransferChecked` CPI accepted a zero transfer. Restoring the guard, rebuilding, and rerunning all 10 tests passed. No negative-control mutation remains.

Final tested SBF SHA-256: `556c25e477c151cf540535a963182f14ed436fa43bfda8c397ee16c47fa2829e`.
Generated IDL SHA-256: `b420b947825cc44b1d4ec0561382ec2c681f113384a05fec0c906cc089a36422`.

This pass reused installed project-local build tools and dependency caches; a clean-machine bootstrap was not independently repeated. NixOS host already had `nix-ld` for upstream platform-tools binaries. No host configuration was modified.

## Milestone 2 loan lifecycle implementation

The Anchor program now includes persistent `Loan` accounts and the complete local prototype flow: `propose_loan`, `approve_loan`, `draw_loan`, `repay_loan`, `withdraw_available` and `set_disbursement_paused`. Terms are fixed at proposal, two distinct configured approvers are required, draw and repayment update vault accounting atomically with legacy SPL Token transfers, and withdrawal is limited to actual vault cash.

The existing vault regression suite remains green, and `loan_lifecycle_requires_approvals_and_closes_once` exercises the compiled SBF through proposal, both approvals, draw, repayment, pause and dual-approver withdrawal in LiteSVM. This is implementation evidence only; the local-validator deployment gate remains unpassed and no deployment is claimed.

### LSP limitation

Proactive Rust LSP diagnostics emitted false primitive/slice errors such as `cannot apply unary operator ! to type bool`. Host Rust source was absent during diagnosis; cached findings persisted even after the parent's attempted session deferral. Pinned-shell Cargo compilation, all-target checking and actual runtime tests passed instead; Rust LSP cleanliness is **not** claimed and correct code was not rewritten or suppressed to silence those errors.

## Independent review and accepted corrections

The parent independently reran the full build/runtime/check/format/Clippy sequence and the public-only fixture. All 10 runtime tests passed, fixture balances matched, and SBF/IDL hashes matched the values above. A fresh security reviewer found no blocker for this local-only sandbox.

Two accepted findings were addressed without program changes:

- **Nested Nix dependency lookup:** `cargo-build-sbf` 4.3.0 invokes `nix-build` with `import <nixpkgs> {}` to patch upstream ELF dependencies on NixOS. That lookup previously inherited the host search path instead of `flake.lock`. `flake.nix` now sets the development shell's `NIX_PATH` directly to the locked input's `outPath`; no host configuration is changed.
- **Mint authority disclosure:** README now states that the fixture treasury retains mint authority and can issue additional test tokens, while the mint has no freeze authority. This documents the existing `create_mint` fixture behavior.

Focused regression check:

```sh
bash scripts/check-nix-path.sh
```

Before the fix it failed with `file 'nixpkgs' was not found in the Nix search path` when inherited `NIX_PATH` was unset. After the fix, nested `nix-instantiate --find-file nixpkgs` matched the source resolved from `flake.lock` for both unset and deliberately bogus inherited `NIX_PATH`. The test selects its Bash executable explicitly so nix-shell's startup Bash lookup is separate from the nested lookup being checked.

Fresh writer rerun after the environment change (exit 0):

```sh
nix-shell --run 'bash scripts/bootstrap.sh && bash scripts/build.sh && cargo test --locked -p forge && cargo check --locked -p forge --all-targets && cargo fmt --all -- --check && cargo clippy --locked -p forge --all-targets -- -D warnings'
bash -n scripts/check-nix-path.sh scripts/bootstrap.sh scripts/build.sh
sha256sum target/deploy/forge.so target/idl/forge.json
```

SBF/IDL generation passed, all 10 runtime tests passed, compiler/format/Clippy checks passed, shell syntax passed, and both artifact hashes remained unchanged. Proactive diagnostics for the changed Nix file and new shell check reported no errors; the separate Rust LSP limitation remains as described above.

**Residual supply-chain trust:** the upstream builder selects platform-tools release v1.57, but this repository does not pin the compiler archive's SHA-256 or use a fixed-output Nix downloader for that archive. That optional hardening is deferred, not implemented or claimed. The build reused existing tool and dependency caches; the new check proves nested lookup selection, not a full cold download/repatch or clean-machine bootstrap. Local-validator deployment and its acceptance gate remain unapproved/unpassed.

## JavaScript dependency evaluation (candidate rejected)

An optional TypeScript seed client was investigated using Node 24.20.0 / npm 11.19.0. Initial `npm install --ignore-scripts` succeeded; lifecycle scripts were not run. `npm audit --json` failed with 12 findings (5 high, 7 moderate, including parent-package metavulnerabilities). Exact candidate paths:

- `@anchor-lang/core@1.2.0 → toml@3.0.0`: [recursion](https://github.com/advisories/GHSA-82x6-q7mm-w9cf), [prototype pollution](https://github.com/advisories/GHSA-v5mp-jgw5-2x6j).
- `@solana/spl-token@0.4.15 → @solana/buffer-layout-utils@0.3.0 → bigint-buffer@1.1.5`: [native buffer overflow](https://github.com/advisories/GHSA-3gc7-fjrx-p6mg).
- `@solana/web3.js@1.99.0 → jayson@4.3.0 → stream-json@1.9.1 / uuid@8.3.2`: [nested-input DoS](https://github.com/advisories/GHSA-528h-pc64-c93x), [buffer bounds](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

No blanket override, forced downgrade, audit suppression or risk waiver was applied. The supervisor approved a smaller milestone: retain the existing Rust/LiteSVM fixture and defer the network seed client until deployment approval. Candidate package manifests, npm lockfile, TypeScript configuration and draft seed test were removed; **no JavaScript application/client dependencies are retained**. Ignored `node_modules/` remains an unused local investigation artifact, not a shipped dependency. Node was removed from the development shell. TypeScript typecheck/client tests were not completed and are not claimed as evidence; SDK/API work remains milestone 3. Generated IDL/TS types remain build outputs only.

## Milestones 3–6: SDK, keyless API, reconciler and end-to-end flow — 5 October 2026

Scope: issues #1 (local-validator gate), #3 (SDK), #4 (keyless orchestration), #5 (finalized reconciliation) and #6 (end-to-end flow). Decisions are recorded in `docs/adr/0001`–`0003`. Everything ran on a disposable loopback stack, with no Devnet or mainnet deployment:

- `solana-test-validator` 4.0.3 with the built program loaded at genesis (`--bpf-program`, `--reset`);
- PostgreSQL 17.11, both started by `scripts/localnet.sh`.

### Automated checks

| Command | Result |
| --- | --- |
| `bash scripts/build.sh && cargo test --locked -p forge` | 19 passed (10 vault, 1 lifecycle, 8 negative), including withdrawal replay and stale-pause tests |
| `cargo fmt --all -- --check`, `cargo clippy --locked -p forge --all-targets -- -D warnings` | Passed |
| `bun run --cwd packages/sdk build && bun test` (packages/sdk) | 16 passed: IDL drift, codec round-trips, plan verification, memo uniqueness, signature merge and forgery rejection, error classification, views, JSON-safe timestamps |
| `bun test` (apps/api, local PostgreSQL) | 22 passed: auth isolation, idempotency 409, persist-before-send, partial signatures, confirmed→finalized, proven expiry and re-prepare, RPC outage, concurrent workers, replay classification, direct calls and donations, wallet self-broadcast, memo matching, pruned cursors, webhooks |
| `bun audit` | 17 advisories, all in pre-existing dev tooling (`nx` → axios/smol-toml; site `shadcn`/`serve` and `ultracite` → braces/brace-expansion). None reach `@solana/kit` or the new runtime packages. |

### End-to-end run (`bun run e2e`)

The independent treasury, approver A, approver B, borrower and outsider wallets each signed only their own transactions, after `verifyPlan` decoded the bytes. The API and worker ran as separate processes and never received a key. Result: **25 checks passed**; evidence is written to the ignored `.local/demo/e2e-evidence.json`.

| Check | Observed |
| --- | --- |
| #1 vault on a local validator | Created with immutable approvers; funded with exactly 10,000,000,000 base units |
| #1 unauthorized direct SPL withdrawal | Rejected for both outsider and treasury (`OwnerMismatch`); balances unchanged |
| Premature draw | API refused (409); direct program call rejected (`InvalidLoanState` 6010) |
| Concurrent duplicate approval by approver A | One finalized; the other resolved `already_applied` (`AlreadyApproved`) |
| Wrong signer / wrong destination | `InvalidBorrower` 6016 / `InvalidDestination` 6017, no side effects |
| Draw then repay | Vault cash 10,000 → 5,000 → 10,100; receivable 0 → 5,000 → 0 |
| Repeated draw / repayment | Rejected (6010); cross-institution read and write → 404 |
| Withdrawal proposal | Proposed by A, executed on B's approval; 100 to the treasury destination |
| Pause ordering | Stale unpause failed (`StalePauseSequence` 6019); fresh unpause applied at `pause_seq` 2 |
| Direct token donation | `unexpected_deposit` exception plus suspense posting; no loan change |
| Wallet self-broadcast | Matched by message hash and finalized |
| Worker down while a transaction landed | Finalized after restart |
| Unsigned plan | Expired only after finalized height passed `lastValidBlockHeight`; attempt 2 got a new blockhash and finalized |
| Full replay from empty cursors | No duplicate postings, events, exceptions or webhooks (17 / 14 / 1 / 18) |
| Statement | Balanced; every posting carries signature and slot; ledger cash 10,005 equals finalized chain cash |
| Webhooks | 18 events delivered with 18 unique stable ids |

### Defects found by the run and fixed

1. **Identical messages share one transaction id.** Two approvals planned in the same slot compiled to byte-identical messages. Ed25519 is deterministic, so they collided on the attempt signature. Two identical funding requests would silently have executed once.
   - Fix: every plan now carries an SPL Memo `forge:op:<operationId>:<attemptNo>` (ADR 0002).
   - The reconciler also matches by memo.
2. **Ledger pruning stalls cursors.** `solana-test-validator` keeps 10,000 shreds by default, about 11 minutes here. Once the cursor's transaction was purged, `getSignaturesForAddress(until)` failed with "not found" and the token-account cursor stopped advancing.
   - The indexer now falls back to a slot-bounded scan.
   - The tracker indexes the vault before declaring a live attempt expired.
   - The local validator keeps 500k shreds (several hours; `FORGE_LEDGER_SHREDS` overrides).
   - Worker heartbeats now keep each stage's last error until that stage recovers.
3. **Timestamps serialized as `{}`.** Found while driving the console against the live stack. `toJsonSafe` walked a `Date` like a plain object, so every API timestamp came out as `{}` and the console showed the worker as "stale NaNs". Dates now serialize as ISO-8601, and tests assert it.
   - After the fix, a loan was proposed and signed in the console as approver A and finalized at slot 1388. The console showed "0 of 2 approvals" and "Proposed" as separate states.
4. The run also corrected a wrong expectation (destination substitution reports 6017, as `loan_negative.rs` already asserts).

### Remaining limits

- `solana-test-validator` binds RPC (8899), websocket (8900) and faucet (9900) to `0.0.0.0` and has no flag to restrict them. The tested NixOS host firewall blocks inbound connections.
- Expiry proofs and indexer cursors need an RPC node that retains history beyond worker downtime. Absence of a signature on a pruned node proves nothing; production needs history-retaining RPC providers.
- The console signs with browser-held demonstration keys served from `.local/demo/session.json` by the console's development server. There is no wallet adapter or custody integration.
- Devnet and mainnet deployment remain unapproved.
