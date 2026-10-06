import { FORGE_PROGRAM_ID } from "@forge/sdk";
import { z } from "zod";

import { authenticate } from "./auth";
import type { Institution } from "./auth";
import type { Chain } from "./chain";
import type { Db } from "./db";
import { errorResponse, idempotencyKey, json, readBody } from "./http";
import { Operations } from "./operations";
import { Reads } from "./reads";
import { Requests, schemas } from "./requests";

/** Path parameters of a route, by name (e.g. `Params<"vault">` for `/v1/vaults/:vault`). */
type Params<K extends string = never> = Record<K, string>;
type Handler<K extends string = never> = (
  request: Request & { params: Params<K> },
  institution: Institution
) => Promise<Response>;

// Creates an operation from a validated body; 201 when new, 200 for an idempotent replay.
const plan =
  <S extends z.ZodType, K extends string = never>(
    schema: S,
    run: (
      institution: Institution,
      key: string,
      params: Params<K>,
      body: z.infer<S>
    ) => Promise<{
      created: boolean;
      operation: unknown;
    }>
  ): Handler<K> =>
  async (request, institution) => {
    const key = idempotencyKey(request);
    const body = await readBody(request, schema);
    const { created, operation } = await run(
      institution,
      key,
      request.params,
      body
    );
    return json(operation, created ? 201 : 200);
  };

export function createServer(deps: {
  db: Db;
  chain: Chain;
  host: string;
  port: number;
}) {
  const operations = new Operations(deps.db, deps.chain);
  const requests = new Requests(deps.db, deps.chain, operations);
  const reads = new Reads(deps.db, deps.chain);

  const authed =
    <K extends string = never>(handler: Handler<K>) =>
    async (request: Request & { params: Params<K> }) => {
      try {
        return await handler(request, await authenticate(deps.db, request));
      } catch (error) {
        return errorResponse(error);
      }
    };

  const submitSchema = z
    .object({ transaction: z.string().min(1).max(4096) })
    .strict();

  return Bun.serve({
    error: (error) => errorResponse(error),
    fetch: () =>
      json({ error: { code: "not_found", message: "Route not found" } }, 404),
    hostname: deps.host,
    port: deps.port,
    routes: {
      "/health": { GET: () => json({ service: "forge-api", status: "ok" }) },
      "/v1/events": {
        GET: authed(async (r, i) => {
          const after = Number(new URL(r.url).searchParams.get("after") ?? 0);
          return json(
            await reads.events(i, Number.isFinite(after) ? after : 0)
          );
        }),
      },
      "/v1/loans/:loan": {
        GET: authed<"loan">(async (r, i) =>
          json(await reads.loan(i, r.params.loan))
        ),
      },
      "/v1/loans/:loan/approve": {
        POST: authed<"loan">(
          plan(schemas.approve, (i, k, p, b) =>
            requests.approveLoan(i, k, p.loan, b)
          )
        ),
      },
      "/v1/loans/:loan/draw": {
        POST: authed<"loan">(
          plan(schemas.draw, (i, k, p, b) => requests.drawLoan(i, k, p.loan, b))
        ),
      },
      "/v1/loans/:loan/repay": {
        POST: authed<"loan">(
          plan(schemas.repay, (i, k, p, b) =>
            requests.repayLoan(i, k, p.loan, b)
          )
        ),
      },
      "/v1/operations/:id": {
        GET: authed<"id">(async (r, i) =>
          json(await operations.get(i, r.params.id))
        ),
      },
      "/v1/operations/:id/prepare": {
        POST: authed<"id">(async (r, i) =>
          json(await operations.reprepare(i, r.params.id), 201)
        ),
      },
      "/v1/operations/:id/signatures": {
        POST: authed<"id">(async (r, i) => {
          const body = await readBody(r, submitSchema);
          return json(
            await operations.submit(i, r.params.id, body.transaction)
          );
        }),
      },
      "/v1/status": {
        GET: authed(async () =>
          json({ programId: FORGE_PROGRAM_ID, ...(await reads.status()) })
        ),
      },
      "/v1/vaults": {
        GET: authed(async (_r, i) => json(await reads.vaults(i))),
        POST: authed(
          plan(schemas.createVault, (i, k, _p, b) =>
            requests.createVault(i, k, b)
          )
        ),
      },
      "/v1/vaults/:vault": {
        GET: authed<"vault">(async (r, i) =>
          json(await reads.vault(i, r.params.vault))
        ),
      },
      "/v1/vaults/:vault/fund": {
        POST: authed<"vault">(
          plan(schemas.fundVault, (i, k, p, b) =>
            requests.fundVault(i, k, p.vault, b)
          )
        ),
      },
      "/v1/vaults/:vault/loans": {
        GET: authed<"vault">(async (r, i) =>
          json(await reads.loans(i, r.params.vault))
        ),
        POST: authed<"vault">(
          plan(schemas.proposeLoan, (i, k, p, b) =>
            requests.proposeLoan(i, k, p.vault, b)
          )
        ),
      },
      "/v1/vaults/:vault/operations": {
        GET: authed<"vault">(async (r, i) =>
          json(await reads.operations(i, r.params.vault))
        ),
      },
      "/v1/vaults/:vault/pause": {
        POST: authed<"vault">(
          plan(schemas.pause, (i, k, p, b) =>
            requests.setPause(i, k, p.vault, b)
          )
        ),
      },
      "/v1/vaults/:vault/statement": {
        GET: authed<"vault">(async (r, i) =>
          json(await reads.statement(i, r.params.vault))
        ),
      },
      "/v1/vaults/:vault/withdrawals": {
        GET: authed<"vault">(async (r, i) =>
          json(await reads.withdrawals(i, r.params.vault))
        ),
        POST: authed<"vault">(
          plan(schemas.proposeWithdrawal, (i, k, p, b) =>
            requests.proposeWithdrawal(i, k, p.vault, b)
          )
        ),
      },
      "/v1/withdrawals/:withdrawal/approve": {
        POST: authed<"withdrawal">(
          plan(schemas.approve, (i, k, p, b) =>
            requests.approveWithdrawal(i, k, p.withdrawal, b)
          )
        ),
      },
    },
  });
}
