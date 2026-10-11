# ADR 0001 — TypeScript for the API and worker

Status: accepted (2026-10-05) · Supersedes: the Go `services/banking` scaffold

## Context

- The MVP specification chose TypeScript for the API "so it can share the Anchor client with the SDK" (`docs/FORGE-MVP-v0.1.md:44`).
- Issue #4 asks the API to return "SDK-generated plans". A Go service cannot call the TypeScript SDK in-process.
- `services/banking` was a 35-line Go health check with no chain, database or key integration.
- Go has no first-party Anchor client, so a Go API would need a second transaction codec kept in sync with the SDK.
- The earlier TypeScript seed client was rejected for audit findings in `@anchor-lang/core`, `@solana/spl-token` and `@solana/web3.js` v1 (`docs/validation.md`, "JavaScript dependency evaluation").

## Decision

1. **The API and worker are one Bun package, `apps/api`.** It has two entrypoints, `api` and `worker`, plus `all` for local development. Both import `@forge/sdk` for plans, PDAs, decoding and error classification.
2. **Retire `services/banking`.** The bank-side role from the specification (`examples/bank-core`) is not part of this service. Banks consume REST and webhooks.
3. **The client stack is `@solana/kit` 8.x.** Do not use `@solana/web3.js` v1, `@anchor-lang/core` or `@solana/spl-token`.
   - The SDK codec is driven by the generated Anchor IDL: discriminators, argument layouts, account order and signer/writable flags all come from `target/idl/forge.json`. This prevents drift between the SDK and the program.
   - Token fixtures (local harness only) use `@solana-program/token` and `@solana-program/system`. Both are generated against kit.
4. **No gRPC between modules.**
   - The API and worker share only PostgreSQL tables. Nothing calls across them synchronously.
   - External interfaces are REST plus webhooks (specification §6).
   - Browsers and wallets need serialized transaction bytes, not protobuf.
5. **PostgreSQL access uses Bun's built-in `SQL` client.** This avoids a driver dependency. u64 amounts are stored as `numeric(20,0)`, because `bigint` is signed 64-bit. In TypeScript they are `bigint`, and in JSON they are decimal strings.

## Consequences

- One builder implementation serves the API, the console and third-party TypeScript callers. Non-TypeScript banks consume the REST plans.
- `bun audit` must stay clean. The audit result is recorded in `docs/validation.md`.
- Issue #4's "extend existing Bun backend" now means `apps/api`.
