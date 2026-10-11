import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError, createApi, loadSession } from "./api";
import type {
  Loan,
  Operation,
  Role,
  Session,
  Statement,
  Status,
  Vault,
  WebhookEvent,
  Withdrawal,
} from "./api";
import { short } from "./format";
import {
  Actions,
  Events,
  Loans,
  Operations,
  StatementView,
  Summary,
  Withdrawals,
} from "./panels";
import { Review } from "./review";
import { ROLES, ROLE_LABELS, loadSigners } from "./signers";
import type { DemoSigner } from "./signers";
import { Empty, ThemeToggle } from "./ui";

export interface Data {
  status: Status | null;
  vaults: Vault[];
  vault: Vault | null;
  loans: Loan[];
  withdrawals: Withdrawal[];
  operations: Operation[];
  statement: Statement | null;
  events: WebhookEvent[];
}

const EMPTY: Data = {
  events: [],
  loans: [],
  operations: [],
  statement: null,
  status: null,
  vault: null,
  vaults: [],
  withdrawals: [],
};

const NAV = [
  ["overview", "Overview"],
  ["actions", "Actions"],
  ["loans", "Loans"],
  ["withdrawals", "Withdrawals"],
  ["operations", "Operations"],
  ["statement", "Statement"],
  ["events", "Webhook events"],
] as const;

function workerLabel(workerAge: number | null) {
  if (workerAge === null) {
    return "not running";
  }
  return workerAge < 10 ? "live" : `stale ${Math.round(workerAge)}s`;
}

export function App() {
  const [session, setSession] = useState<Session | null | undefined>();
  const [signers, setSigners] = useState<Record<Role, DemoSigner> | null>(null);
  const [role, setRole] = useState<Role>("treasury");
  const [data, setData] = useState<Data>(EMPTY);
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [current, setCurrent] = useState<string>(NAV[0][0]);
  const [notice, setNotice] = useState<{
    tone: "error" | "info";
    text: string;
  } | null>(null);

  useEffect(() => {
    const init = async () => {
      const loaded = await loadSession();
      setSession(loaded);
      if (loaded) {
        setSigners(await loadSigners(loaded));
      }
    };
    void init();
  }, []);

  const api = useMemo(
    () => (session ? createApi(session.apiKey) : null),
    [session]
  );

  const refresh = useCallback(async () => {
    if (!api) {
      return;
    }
    try {
      const [status, vaults, events] = await Promise.all([
        api<Status>("GET", "/v1/status"),
        api<Vault[]>("GET", "/v1/vaults"),
        api<WebhookEvent[]>("GET", "/v1/events"),
      ]);
      const vault = vaults[0] ?? null;
      if (!vault) {
        setData({ ...EMPTY, events, status, vaults });
        return;
      }
      const base = `/v1/vaults/${vault.address}`;
      const [fresh, loans, withdrawals, operations, statement] =
        await Promise.all([
          api<Vault>("GET", base),
          api<Loan[]>("GET", `${base}/loans`),
          api<Withdrawal[]>("GET", `${base}/withdrawals`),
          api<Operation[]>("GET", `${base}/operations`),
          api<Statement>("GET", `${base}/statement`),
        ]);
      setData({
        events,
        loans,
        operations,
        statement,
        status,
        vault: fresh,
        vaults,
        withdrawals,
      });
    } catch (error) {
      setNotice({ text: (error as Error).message, tone: "error" });
    }
  }, [api]);

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- initial poll; refresh sets state only after its API calls resolve
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Marks the last section whose top has reached the top of the viewport. At the
  // bottom of the page short sections never get there, so prefer the one the user picked.
  const ready = Boolean(session && signers && api);
  useEffect(() => {
    if (!ready) {
      return;
    }
    const onScroll = () => {
      const sections = NAV.map(([id]) => document.querySelector(`#${id}`))
        .filter((section) => section !== null)
        .map((section) => ({
          id: section.id,
          top: section.getBoundingClientRect().top,
        }));
      const atBottom =
        window.innerHeight + window.scrollY >=
        document.documentElement.scrollHeight - 1;
      const picked = window.location.hash.slice(1);
      const visible = sections.filter((x) => x.top < window.innerHeight);
      const next = atBottom
        ? (visible.find((x) => x.id === picked) ?? visible.at(-1))
        : sections.findLast((x) => x.top <= 96);
      setCurrent(next?.id ?? NAV[0][0]);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [ready]);

  /** Plans an operation and opens its review; nothing is signed until the user confirms. */
  const act = useCallback(
    async (path: string, body: unknown) => {
      if (!api) {
        return;
      }
      setNotice(null);
      try {
        const operation = await api<Operation>("POST", path, body);
        setReviewId(operation.id);
        await refresh();
      } catch (error) {
        const message =
          error instanceof ApiError
            ? `${error.message} (${error.code})`
            : (error as Error).message;
        setNotice({ text: message, tone: "error" });
      }
    },
    [api, refresh]
  );

  if (session === undefined) {
    return <div className="boot">Loading demo session…</div>;
  }
  if (session === null || !signers || !api) {
    return (
      <div className="boot">
        <Empty title="No local demo session">
          Start the stack and seed demonstration wallets:{" "}
          <code>nix-shell --run &apos;bash scripts/localnet.sh up&apos;</code>,
          then <code>bun run --cwd apps/localnet seed</code> and reload.
        </Empty>
      </div>
    );
  }

  // oxlint-disable-next-line react/purity -- heartbeat age is read at render time; the 2 s poll re-renders it
  const renderedAt = Date.now();
  const workerAge = data.status?.worker
    ? (renderedAt - new Date(data.status.worker.seen_at).getTime()) / 1000
    : null;

  return (
    <div className="shell">
      <aside
        className="rail"
        aria-label="Navigation and signer"
        inert={reviewId !== null}
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word">FORGE</span>
        </div>
        <nav>
          {NAV.map(([id, label]) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={id === current ? "true" : undefined}
              onClick={() => setCurrent(id)}
            >
              {label}
            </a>
          ))}
        </nav>
        <div className="signer-switch">
          <p className="eyebrow">Acting as</p>
          {ROLES.map((r) => (
            <button
              key={r}
              type="button"
              className={r === role ? "role active" : "role"}
              aria-pressed={r === role}
              onClick={() => setRole(r)}
            >
              <span>{ROLE_LABELS[r]}</span>
              <span className="mono">{short(signers[r].address)}</span>
            </button>
          ))}
          <p className="fine">
            Demo keys stay in this tab and sign locally. The FORGE API never
            receives a key.
          </p>
        </div>
        <ThemeToggle />
      </aside>

      <main className="content" inert={reviewId !== null}>
        <header className="topbar">
          <div>
            <p className="eyebrow">
              Local sandbox · {data.status?.network ?? "…"}
            </p>
            <h1>Bank-controlled lending</h1>
          </div>
          <dl className="health">
            <div>
              <dt>Program</dt>
              <dd className="mono">{short(data.status?.programId, 6)}</dd>
            </div>
            <div>
              <dt>Finalized height</dt>
              <dd className="numeric">
                {data.status?.finalizedHeight ?? "unreachable"}
              </dd>
            </div>
            <div>
              <dt>Worker</dt>
              <dd>{workerLabel(workerAge)}</dd>
            </div>
          </dl>
        </header>

        {notice && (
          <div role="alert" className={`notice notice-${notice.tone}`}>
            {notice.text}
            <button
              type="button"
              className="link"
              onClick={() => setNotice(null)}
            >
              Dismiss
            </button>
          </div>
        )}

        <Summary data={data} />
        <Actions
          data={data}
          role={role}
          session={session}
          signers={signers}
          act={act}
        />
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
