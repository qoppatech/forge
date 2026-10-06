import {
  decodeWireTransaction,
  inspectTransaction,
  signPlanTransaction,
  verifyPlan,
} from "@forge/sdk";
import type { InspectedTransaction } from "@forge/sdk";
import { useCallback, useEffect, useState } from "react";

import type { Api, Operation, Role } from "./api";
import { ASSET, KIND_LABELS, STATUS, tokens, unixDate } from "./format";
import { roleOf } from "./signers";
import type { DemoSigner } from "./signers";
import { Amount, Badge, Id } from "./ui";

interface Props {
  operationId: string;
  api: Api;
  role: Role;
  signers: Record<Role, DemoSigner>;
  onRole: (role: Role) => void;
  onClose: () => void;
  onChanged: () => Promise<void>;
}

const STEPS = ["prepared", "submitted", "confirmed", "finalized"] as const;

interface PlanCheck {
  problems: string[];
  inspected: InspectedTransaction;
}

/** Signers recorded on the open plan, else on the latest attempt. */
function latestSignedBy(op: Operation): string[] {
  return op.plan?.signedBy ?? op.attempts.at(-1)?.signedBy ?? [];
}

/** Result of decoding the plan bytes client-side and comparing them with the intent. */
function PlanChecks({
  plan,
  checks,
  signers,
}: {
  plan: NonNullable<Operation["plan"]>;
  checks: PlanCheck | null;
  signers: Record<Role, DemoSigner>;
}) {
  if (!checks) {
    return <p className="fine">Decoding…</p>;
  }
  return (
    <>
      {checks.problems.length === 0 ? (
        <Badge tone="success">
          Decoded transaction matches this intent exactly
        </Badge>
      ) : (
        <div role="alert" className="notice notice-error">
          Do not sign: {checks.problems.join("; ")}
        </div>
      )}
      <dl className="facts stacked mono-facts">
        <div>
          <dt>Program</dt>
          <dd>
            <Id value={plan.programId} size={6} />
          </dd>
        </div>
        <div>
          <dt>Fee payer</dt>
          <dd>
            {roleOf(signers, checks.inspected.feePayer)?.label ?? "External"}{" "}
            <Id value={checks.inspected.feePayer} />
          </dd>
        </div>
        <div>
          <dt>Instructions</dt>
          <dd>
            {checks.inspected.instructions
              .map((ix) => ix.intent?.kind ?? (ix.memo ? "memo" : "other"))
              .join(" + ")}
          </dd>
        </div>
        <div>
          <dt>Operation memo</dt>
          <dd className="mono">{plan.memo}</dd>
        </div>
        <div>
          <dt>Valid until block</dt>
          <dd className="numeric">{plan.lastValidBlockHeight}</dd>
        </div>
      </dl>
    </>
  );
}

/** Facts a signer must see before signing (DESIGN.md approval panel). */
function facts(op: Operation): [string, React.ReactNode][] {
  const i = op.intent;
  const d = op.display;
  const rows: [string, React.ReactNode][] = [];
  const amount = d.amount ?? d.principal;
  if (amount) {
    rows.push([
      d.amount ? "Amount" : "Principal",
      <Amount key="a" base={amount} />,
    ]);
  }
  if (d.interest) {
    rows.push(["Fixed interest", <Amount key="i" base={d.interest} />]);
  }
  if (d.payoff) {
    rows.push(["Fixed payoff", <Amount key="p" base={d.payoff} />]);
  }
  if (i.termRateBps !== undefined) {
    rows.push([
      "Whole-term rate",
      `${(i.termRateBps / 100).toFixed(2)}% (${i.termRateBps} bps)`,
    ]);
  }
  if (i.termSeconds) {
    rows.push([
      "Term",
      `${Math.round(Number(i.termSeconds) / 86_400)} days after draw`,
    ]);
  }
  if (i.offerExpiry) {
    rows.push(["Offer expires", unixDate(i.offerExpiry)]);
  }
  if (i.borrower ?? d.borrower) {
    rows.push([
      "Borrower",
      <Id key="b" value={i.borrower ?? d.borrower} size={6} />,
    ]);
  }
  const destination = i.destination ?? i.treasuryDestination ?? d.destination;
  if (destination) {
    rows.push(["Destination", <Id key="d" value={destination} size={6} />]);
  }
  if (i.approvers) {
    rows.push([
      "Approvers",
      <span key="ap">
        <Id value={i.approvers[0]} /> <Id value={i.approvers[1]} />
      </span>,
    ]);
  }
  if (i.perLoanLimit) {
    rows.push([
      "Limits",
      `${tokens(i.perLoanLimit)} per loan · ${tokens(i.outstandingLimit)} outstanding ${ASSET}`,
    ]);
  }
  if (i.paused !== undefined) {
    rows.push([
      "Change",
      `${i.paused ? "Pause" : "Resume"} draws (from pause sequence ${i.expectedSeq})`,
    ]);
  }
  rows.push(["Vault", <Id key="v" value={op.vault} size={6} />]);
  return rows;
}

export function Review({
  operationId,
  api,
  role,
  signers,
  onRole,
  onClose,
  onChanged,
}: Props) {
  const [op, setOp] = useState<Operation | null>(null);
  const [checks, setChecks] = useState<PlanCheck | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async () =>
      setOp(await api<Operation>("GET", `/v1/operations/${operationId}`)),
    [api, operationId]
  );

  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- initial fetch; load sets state only after the API call resolves
    void load();
    const timer = setInterval(() => {
      void load();
    }, 1500);
    return () => clearInterval(timer);
  }, [load]);

  // Client-side review: decode the exact bytes and compare them with the intent.
  const planBytes = op?.plan?.transaction;
  useEffect(() => {
    if (!op?.plan) {
      // oxlint-disable-next-line react/set-state-in-effect -- clear the previous plan's checks once the plan is gone
      setChecks(null);
      return;
    }
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- re-verify only when the plan bytes change, not on every poll
    const { plan } = op;
    const verify = async () => {
      const problems = await verifyPlan({
        intent: op.intent as never,
        memo: plan.memo,
        messageHash: plan.messageHash,
        requiredSigners: op.requiredSigners,
        transaction: plan.transaction,
      });
      setChecks({
        inspected: inspectTransaction(decodeWireTransaction(plan.transaction)),
        problems,
      });
    };
    void verify();
  }, [planBytes]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      await onChanged();
    } catch (actionError) {
      setError((actionError as Error).message);
      // oxlint-disable-next-line react/todo -- try/finally keeps busy cleared on every path; this app does not use React Compiler
    } finally {
      setBusy(false);
    }
  }

  if (!op) {
    return null;
  }
  const signer = signers[role];
  const { plan } = op;
  const signedBy = latestSignedBy(op);
  const mustSign =
    plan &&
    op.requiredSigners.includes(signer.address) &&
    !signedBy.includes(signer.address);
  const status = STATUS[op.status] ?? {
    label: op.status,
    tone: "neutral" as const,
  };
  const stepIndex = STEPS.indexOf(op.status as (typeof STEPS)[number]);
  const verified = checks && checks.problems.length === 0;

  return (
    <div
      className="drawer-backdrop"
      role="presentation"
      onClick={(e) => {
        // Only a click on the backdrop itself closes the drawer.
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      <aside
        className="drawer"
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- side drawer keeps its layout; <dialog> brings UA styles and top-layer behaviour
        role="dialog"
        aria-modal="true"
        aria-labelledby="review-title"
      >
        <header className="drawer-header">
          <div>
            <p className="eyebrow">
              {op.origin === "chain"
                ? "Observed on chain (direct call)"
                : "Operation review"}
            </p>
            <h2 id="review-title">{KIND_LABELS[op.kind] ?? op.kind}</h2>
          </div>
          <button type="button" className="link" onClick={onClose}>
            Close
          </button>
        </header>

        <Badge tone={status.tone}>{status.label}</Badge>
        {op.statusReason && <p className="reason">{op.statusReason}</p>}

        <ol className="steps" aria-label="Settlement progress">
          {STEPS.map((step, i) => (
            <li key={step} className={stepIndex >= i ? "done" : ""}>
              {STATUS[step]?.label.replace(" — prepare again", "")}
            </li>
          ))}
        </ol>

        <h3>What will execute</h3>
        <dl className="facts stacked">
          {facts(op).map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        {plan && (
          <>
            <h3>Verification of the bytes you sign</h3>
            <PlanChecks plan={plan} checks={checks} signers={signers} />
          </>
        )}

        <h3>Signatures</h3>
        <ul className="signers">
          {op.requiredSigners.map((address, i) => {
            const who = roleOf(signers, address);
            const done =
              signedBy.includes(address) ||
              ["submitted", "confirmed", "finalized"].includes(op.status);
            return (
              <li key={address}>
                <span>
                  {who?.label ?? "External signer"}
                  {i === 0 && <span className="tag">fee payer</span>}
                </span>
                <Id value={address} />
                {done ? (
                  <Badge tone="success">Signed</Badge>
                ) : (
                  <Badge tone="warning">Awaiting</Badge>
                )}
                {!done && who && who.role !== role && op.plan && (
                  <button
                    type="button"
                    className="link"
                    onClick={() => onRole(who.role)}
                  >
                    Switch to {who.label}
                  </button>
                )}
              </li>
            );
          })}
        </ul>

        {error && (
          <div role="alert" className="notice notice-error">
            {error}
          </div>
        )}

        <div className="drawer-actions">
          {mustSign && (
            <button
              type="button"
              className="primary"
              disabled={busy || !verified}
              onClick={() =>
                run(async () => {
                  const signed = await signPlanTransaction(plan.transaction, [
                    signer.keyPair,
                  ]);
                  await api("POST", `/v1/operations/${op.id}/signatures`, {
                    transaction: signed,
                  });
                })
              }
            >
              Sign as {signer.label}
            </button>
          )}
          {op.status === "expired" && (
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                run(() => api("POST", `/v1/operations/${op.id}/prepare`))
              }
            >
              Prepare a new attempt
            </button>
          )}
        </div>

        <h3>Attempts</h3>
        <ol className="attempts">
          {op.attempts.map((a) => (
            <li key={a.attemptNo}>
              <strong>#{a.attemptNo}</strong> {a.status.replaceAll("_", " ")}
              {a.confirmation && ` · ${a.confirmation}`}
              {a.slot && ` · slot ${a.slot}`}
              {a.sendCount > 0 && ` · sent ${a.sendCount}×`}
              <div>
                <Id value={a.signature} size={8} />
              </div>
              {a.lastSendError && (
                <div className="fine">Last send error: {a.lastSendError}</div>
              )}
            </li>
          ))}
        </ol>
        {op.error && (
          <details>
            <summary>Program error</summary>
            <pre>{JSON.stringify(op.error, null, 2)}</pre>
          </details>
        )}
        <details>
          <summary>Decoded intent</summary>
          <pre>{JSON.stringify(op.intent, null, 2)}</pre>
        </details>
      </aside>
    </div>
  );
}
