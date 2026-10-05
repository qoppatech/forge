import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, createApi, loadSession, type Operation, type Role, type Session } from "./api";
import { short } from "./format";
import { Actions, Events, Loans, Operations, StatementView, Summary, Withdrawals } from "./Panels";
import { Review } from "./Review";
import { ROLE_LABELS, loadSigners, type DemoSigner } from "./signers";
import { Empty } from "./ui";

export interface Data {
  status: { programId: string; network: string; finalizedHeight: string | null; worker: { worker_id: string; seen_at: string } | null } | null;
  vaults: any[];
  vault: any | null;
  loans: any[];
  withdrawals: any[];
  operations: Operation[];
  statement: any | null;
  events: any[];
}

const EMPTY: Data = { status: null, vaults: [], vault: null, loans: [], withdrawals: [], operations: [], statement: null, events: [] };

const NAV = [
  ["overview", "Overview"],
  ["actions", "Actions"],
  ["loans", "Loans"],
  ["withdrawals", "Withdrawals"],
  ["operations", "Operations"],
  ["statement", "Statement"],
  ["events", "Webhook events"],
] as const;

export function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [signers, setSigners] = useState<Record<Role, DemoSigner> | null>(null);
  const [role, setRole] = useState<Role>("treasury");
  const [data, setData] = useState<Data>(EMPTY);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);

  useEffect(() => {
    void loadSession().then(async (loaded) => {
      setSession(loaded);
      if (loaded) setSigners(await loadSigners(loaded));
    });
  }, []);

  const api = useMemo(() => (session ? createApi(session.apiKey) : null), [session]);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const [status, vaults, events] = await Promise.all([api("GET", "/v1/status"), api("GET", "/v1/vaults"), api("GET", "/v1/events")]);
      const vault = vaults[0] ?? null;
      if (!vault) {
        setData({ ...EMPTY, status, vaults, events });
        return;
      }
      const base = `/v1/vaults/${vault.address}`;
      const [fresh, loans, withdrawals, operations, statement] = await Promise.all([
        api("GET", base),
        api("GET", `${base}/loans`),
        api("GET", `${base}/withdrawals`),
        api("GET", `${base}/operations`),
        api("GET", `${base}/statement`),
      ]);
      setData({ status, vaults, vault: fresh, loans, withdrawals, operations, statement, events });
    } catch (error) {
      setNotice({ tone: "error", text: (error as Error).message });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2_000);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Plans an operation and opens its review; nothing is signed until the user confirms. */
  const act = useCallback(
    async (path: string, body: unknown) => {
      if (!api) return;
      setNotice(null);
      try {
        const operation = await api<Operation>("POST", path, body);
        setReviewId(operation.id);
        await refresh();
      } catch (error) {
        const message = error instanceof ApiError ? `${error.message} (${error.code})` : (error as Error).message;
        setNotice({ tone: "error", text: message });
      }
    },
    [api, refresh],
  );

  if (session === undefined) return <div className="boot">Loading demo session…</div>;
  if (session === null || !signers || !api) {
    return (
      <div className="boot">
        <Empty title="No local demo session">
          Start the stack and seed demonstration wallets: <code>nix-shell --run 'bash scripts/localnet.sh up'</code>, then{" "}
          <code>bun run --cwd apps/localnet seed</code> and reload.
        </Empty>
      </div>
    );
  }

  const workerAge = data.status?.worker ? (Date.now() - new Date(data.status.worker.seen_at).getTime()) / 1000 : null;

  return (
    <div className="shell">
      <aside className="rail" aria-label="Navigation and signer">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word">FORGE</span>
        </div>
        <nav>
          {NAV.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <div className="signer-switch">
          <p className="eyebrow">Acting as</p>
          {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
            <button key={r} type="button" className={r === role ? "role active" : "role"} aria-pressed={r === role} onClick={() => setRole(r)}>
              <span>{ROLE_LABELS[r]}</span>
              <span className="mono">{short(signers[r].address)}</span>
            </button>
          ))}
          <p className="fine">Demo keys stay in this tab and sign locally. The FORGE API never receives a key.</p>
        </div>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Local sandbox · {data.status?.network ?? "…"}</p>
            <h1>Bank-controlled lending</h1>
          </div>
          <dl className="health">
            <div>
              <dt>Program</dt>
              <dd className="mono">{short(data.status?.programId, 6)}</dd>
            </div>
            <div>
              <dt>Finalized height</dt>
              <dd className="numeric">{data.status?.finalizedHeight ?? "unreachable"}</dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>{workerAge === null ? "not running" : workerAge < 10 ? "live" : `stale ${Math.round(workerAge)}s`}</dd>
            </div>
          </dl>
        </header>

        {notice && (
          <div role="alert" className={`notice notice-${notice.tone}`}>
            {notice.text}
            <button type="button" className="link" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </div>
        )}

        <Summary data={data} />
        <Actions data={data} role={role} session={session} signers={signers} act={act} />
        <Loans data={data} role={role} signers={signers} act={act} />
        <Withdrawals data={data} role={role} signers={signers} act={act} />
        <Operations data={data} signers={signers} onOpen={setReviewId} />
        <StatementView data={data} />
        <Events data={data} />
      </main>

      {reviewId && (
        <Review
          operationId={reviewId}
          api={api}
          role={role}
          signers={signers}
          onRole={setRole}
          onClose={() => setReviewId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}
