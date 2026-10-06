import { useState } from "react";
import type { SyntheticEvent } from "react";

import type { Operation, Role, Session, Vault } from "./api";
import type { Data } from "./app";
import {
  ASSET,
  KIND_LABELS,
  LOAN_PENDING,
  LOAN_VIEW,
  STATUS,
  baseUnits,
  unixDate,
  when,
} from "./format";
import { roleOf, ROLE_LABELS } from "./signers";
import type { DemoSigner } from "./signers";
import { Amount, Badge, Empty, Field, Id, ScrollRegion, Section } from "./ui";

type Act = (path: string, body: unknown) => Promise<void>;

const isApprover = (role: Role) => role === "approverA" || role === "approverB";

const submit = (fn: () => Promise<void>) => (e: SyntheticEvent) => {
  e.preventDefault();
  void fn();
};

function drawsLabel(vault: Vault) {
  if (vault.disbursement_paused) {
    return "Paused";
  }
  return vault.onchain ? "Open" : "—";
}

function approvalLabel(approvals: boolean[] | null | undefined) {
  const count = (approvals ?? []).filter(Boolean).length;
  return count === 2 ? "Both approvals" : `${count} of 2 approvals`;
}

export function Summary({ data }: { data: Data }) {
  const { vault } = data;
  const pending = data.operations.filter((o) =>
    ["prepared", "submitted", "confirmed"].includes(o.status)
  ).length;
  const reconciliation = data.statement?.reconciliation;
  return (
    <Section
      id="overview"
      title="Vault overview"
      aside={vault && <Id value={vault.address} size={6} />}
    >
      {vault ? (
        <>
          <div className="metrics">
            <div className="metric">
              <span className="metric-label">Vault cash (finalized)</span>
              <span className="metric-value">
                <Amount base={vault.cash} unit={false} />
              </span>
              <span className="metric-unit">{ASSET}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Principal receivable</span>
              <span className="metric-value">
                <Amount base={vault.outstanding_principal} unit={false} />
              </span>
              <span className="metric-unit">{ASSET}</span>
            </div>
            <div className="metric">
              <span className="metric-label">Pending operations</span>
              <span className="metric-value numeric">{pending}</span>
              <span className="metric-unit">
                awaiting signature or settlement
              </span>
            </div>
            <div className="metric">
              <span className="metric-label">Draws</span>
              <span className="metric-value">{drawsLabel(vault)}</span>
              <span className="metric-unit">
                pause sequence {vault.pause_seq ?? "—"}
              </span>
            </div>
          </div>
          <dl className="facts">
            <div>
              <dt>Per-loan limit</dt>
              <dd>
                <Amount base={vault.per_loan_limit} />
              </dd>
            </div>
            <div>
              <dt>Outstanding limit</dt>
              <dd>
                <Amount base={vault.outstanding_limit} />
              </dd>
            </div>
            <div>
              <dt>Approvers</dt>
              <dd>
                <Id value={vault.approvers[0]} />{" "}
                <Id value={vault.approvers[1]} />
              </dd>
            </div>
            <div>
              <dt>Treasury destination</dt>
              <dd>
                <Id value={vault.treasury_destination} />
              </dd>
            </div>
            <div>
              <dt>Reconciliation</dt>
              <dd>
                {reconciliation?.matches ? (
                  <Badge tone="success">Ledger cash matches chain</Badge>
                ) : (
                  <Badge tone="warning">
                    Catching up to slot {vault.synced_slot ?? "—"}
                  </Badge>
                )}
              </dd>
            </div>
          </dl>
        </>
      ) : (
        <Empty title="No vault yet">
          Act as Treasury and create the vault; its two approvers and limits are
          fixed at creation.
        </Empty>
      )}
    </Section>
  );
}

export function Actions({
  data,
  role,
  session,
  signers,
  act,
}: {
  data: Data;
  role: Role;
  session: Session;
  signers: Record<Role, DemoSigner>;
  act: Act;
}) {
  const { vault } = data;
  const [form, setForm] = useState({
    fund: "10000",
    loanRef: `LN-${new Date().getFullYear()}-001`,
    offerHours: "24",
    outstandingLimit: "10000",
    perLoanLimit: "5000",
    principal: "5000",
    rateBps: "200",
    reference: "main",
    termDays: "30",
    withdrawal: "100",
    withdrawalRef: "WD-1",
  });
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <Section id="actions" title={`Actions for ${ROLE_LABELS[role]}`}>
      <div className="action-grid">
        {role === "treasury" && !vault && (
          <form
            className="card"
            onSubmit={submit(() => {
              // Parsed before the outstanding limit, as the form lists them.
              const perLoanLimit = baseUnits(form.perLoanLimit);
              return act("/v1/vaults", {
                approvers: [
                  signers.approverA.address,
                  signers.approverB.address,
                ],
                mint: session.accounts.mint,
                outstandingLimit: baseUnits(form.outstandingLimit),
                perLoanLimit,
                reference: form.reference,
                treasury: signers.treasury.address,
                treasuryDestination: session.accounts.treasuryDestination,
              });
            })}
          >
            <h3>Create vault</h3>
            <Field label="Vault reference">
              <input
                value={form.reference}
                onChange={set("reference")}
                required
              />
            </Field>
            <Field label={`Per-loan limit (${ASSET})`}>
              <input
                inputMode="decimal"
                value={form.perLoanLimit}
                onChange={set("perLoanLimit")}
                required
              />
            </Field>
            <Field label={`Outstanding limit (${ASSET})`}>
              <input
                inputMode="decimal"
                value={form.outstandingLimit}
                onChange={set("outstandingLimit")}
                required
              />
            </Field>
            <p className="fine">
              Approvers: Approver A and Approver B. Mint and destination come
              from the seeded fixture.
            </p>
            <button className="primary" type="submit">
              Plan vault creation
            </button>
          </form>
        )}
        {role === "treasury" && vault && (
          <form
            className="card"
            onSubmit={submit(() =>
              act(`/v1/vaults/${vault.address}/fund`, {
                amount: baseUnits(form.fund),
                source: session.accounts.treasurySource,
              })
            )}
          >
            <h3>Fund vault</h3>
            <Field
              label={`Amount (${ASSET})`}
              hint="Transfers from the treasury source account."
            >
              <input
                inputMode="decimal"
                value={form.fund}
                onChange={set("fund")}
                required
              />
            </Field>
            <button className="primary" type="submit">
              Plan funding
            </button>
          </form>
        )}
        {isApprover(role) && vault && (
          <>
            <form
              className="card"
              onSubmit={submit(() =>
                act(`/v1/vaults/${vault.address}/loans`, {
                  approver: signers[role].address,
                  borrower: signers.borrower.address,
                  destination: session.accounts.borrowerTokens,
                  offerExpiry: String(
                    // oxlint-disable-next-line react/purity -- runs in the submit handler, not during render
                    Math.floor(Date.now() / 1000) +
                      Number(form.offerHours) * 3600
                  ),
                  principal: baseUnits(form.principal),
                  reference: form.loanRef,
                  termRateBps: Number(form.rateBps),
                  termSeconds: String(Number(form.termDays) * 86_400),
                })
              )}
            >
              <h3>Propose loan</h3>
              <Field label="Loan reference">
                <input
                  value={form.loanRef}
                  onChange={set("loanRef")}
                  required
                />
              </Field>
              <Field label={`Principal (${ASSET})`}>
                <input
                  inputMode="decimal"
                  value={form.principal}
                  onChange={set("principal")}
                  required
                />
              </Field>
              <Field
                label="Whole-term rate (bps)"
                hint="200 bps = 2% for the entire term, not annual."
              >
                <input
                  inputMode="numeric"
                  value={form.rateBps}
                  onChange={set("rateBps")}
                  required
                />
              </Field>
              <div className="row">
                <Field label="Term (days)">
                  <input
                    inputMode="numeric"
                    value={form.termDays}
                    onChange={set("termDays")}
                    required
                  />
                </Field>
                <Field label="Offer valid (hours)">
                  <input
                    inputMode="numeric"
                    value={form.offerHours}
                    onChange={set("offerHours")}
                    required
                  />
                </Field>
              </div>
              <button className="primary" type="submit">
                Plan proposal
              </button>
            </form>
            <form
              className="card"
              onSubmit={submit(() =>
                act(`/v1/vaults/${vault.address}/withdrawals`, {
                  amount: baseUnits(form.withdrawal),
                  approver: signers[role].address,
                  reference: form.withdrawalRef,
                })
              )}
            >
              <h3>Propose withdrawal</h3>
              <Field label="Withdrawal reference">
                <input
                  value={form.withdrawalRef}
                  onChange={set("withdrawalRef")}
                  required
                />
              </Field>
              <Field
                label={`Amount (${ASSET})`}
                hint="Executes when the other approver approves; goes only to the fixed treasury destination."
              >
                <input
                  inputMode="decimal"
                  value={form.withdrawal}
                  onChange={set("withdrawal")}
                  required
                />
              </Field>
              <button className="primary" type="submit">
                Plan withdrawal
              </button>
            </form>
            <div className="card">
              <h3>
                {vault.disbursement_paused ? "Resume draws" : "Pause draws"}
              </h3>
              <p className="fine">
                Needs both approvers on one transaction. The plan is pinned to
                pause sequence {vault.pause_seq ?? "0"}, so a stale request
                cannot undo a newer one.
              </p>
              <button
                className="secondary"
                type="button"
                onClick={() => {
                  void act(`/v1/vaults/${vault.address}/pause`, {
                    paused: !vault.disbursement_paused,
                  });
                }}
              >
                Plan {vault.disbursement_paused ? "resume" : "pause"}
              </button>
            </div>
          </>
        )}
        {role === "borrower" && (
          <p className="fine">
            Draw and repay from the loan list once both approvers have approved.
            Only your own wallet signs.
          </p>
        )}
      </div>
    </Section>
  );
}

export function Loans({
  data,
  role,
  signers,
  act,
}: {
  data: Data;
  role: Role;
  signers: Record<Role, DemoSigner>;
  act: Act;
}) {
  const approverIndex = isApprover(role)
    ? data.vault?.approvers.indexOf(signers[role].address)
    : -1;
  return (
    <Section id="loans" title="Loans">
      {data.loans.length === 0 ? (
        <Empty title="No loans">
          An approver proposes a loan with fixed terms; both approvers then
          approve it.
        </Empty>
      ) : (
        <ScrollRegion label="Loans">
          <table>
            <thead>
              <tr>
                <th>Reference</th>
                <th>Borrower</th>
                <th className="num">Principal</th>
                <th className="num">Payoff</th>
                <th>Approval</th>
                <th>Settlement</th>
                <th>Due</th>
                <th aria-label="Action" />
              </tr>
            </thead>
            <tbody>
              {data.loans.map((loan) => {
                const view = LOAN_VIEW[loan.view.status] ?? LOAN_PENDING;
                const canApprove =
                  approverIndex !== undefined &&
                  approverIndex >= 0 &&
                  loan.state === "Proposed" &&
                  !loan.approvals?.[approverIndex];
                return (
                  <tr key={loan.address}>
                    <td>
                      {loan.loan_ref}
                      <div>
                        <Id value={loan.address} />
                      </div>
                    </td>
                    <td>
                      <Id value={loan.borrower} />
                    </td>
                    <td className="num">
                      <Amount base={loan.principal} />
                    </td>
                    <td className="num">
                      <Amount base={loan.fixed_payoff} />
                    </td>
                    <td>
                      <Badge
                        tone={
                          (loan.approvals ?? []).every(Boolean) &&
                          loan.approvals
                            ? "success"
                            : "warning"
                        }
                      >
                        {approvalLabel(loan.approvals)}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={view.tone}>{view.label}</Badge>
                    </td>
                    <td>
                      {loan.view.dueAt
                        ? unixDate(loan.view.dueAt)
                        : `Offer until ${unixDate(loan.offer_expiry)}`}
                    </td>
                    <td className="actions">
                      {canApprove && (
                        <button
                          className="secondary"
                          type="button"
                          onClick={() => {
                            void act(`/v1/loans/${loan.address}/approve`, {
                              approver: signers[role].address,
                            });
                          }}
                        >
                          Approve
                        </button>
                      )}
                      {role === "borrower" &&
                        loan.view.status === "approved" && (
                          <button
                            className="primary"
                            type="button"
                            onClick={() => {
                              void act(`/v1/loans/${loan.address}/draw`, {});
                            }}
                          >
                            Draw
                          </button>
                        )}
                      {role === "borrower" &&
                        (loan.view.status === "active" ||
                          loan.view.status === "overdue") && (
                          <button
                            className="primary"
                            type="button"
                            onClick={() => {
                              void act(`/v1/loans/${loan.address}/repay`, {});
                            }}
                          >
                            Repay
                          </button>
                        )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Section>
  );
}

export function Withdrawals({
  data,
  role,
  signers,
  act,
}: {
  data: Data;
  role: Role;
  signers: Record<Role, DemoSigner>;
  act: Act;
}) {
  const approverIndex = isApprover(role)
    ? data.vault?.approvers.indexOf(signers[role].address)
    : -1;
  if (data.withdrawals.length === 0) {
    return null;
  }
  return (
    <Section id="withdrawals" title="Withdrawals">
      <ScrollRegion label="Withdrawals">
        <table>
          <thead>
            <tr>
              <th>Reference</th>
              <th className="num">Amount</th>
              <th>Approval</th>
              <th>State</th>
              <th aria-label="Action" />
            </tr>
          </thead>
          <tbody>
            {data.withdrawals.map((w) => (
              <tr key={w.address}>
                <td>
                  {w.withdrawal_ref}
                  <div>
                    <Id value={w.address} />
                  </div>
                </td>
                <td className="num">
                  <Amount base={w.amount} />
                </td>
                <td>
                  <Badge tone={w.state === "Executed" ? "success" : "warning"}>
                    {approvalLabel(w.approvals)}
                  </Badge>
                </td>
                <td>
                  <Badge tone={w.state === "Executed" ? "success" : "neutral"}>
                    {w.state ?? "Not on chain yet"}
                  </Badge>
                </td>
                <td className="actions">
                  {approverIndex !== undefined &&
                    approverIndex >= 0 &&
                    w.state === "Proposed" &&
                    !w.approvals?.[approverIndex] && (
                      <button
                        className="secondary"
                        type="button"
                        onClick={() => {
                          void act(`/v1/withdrawals/${w.address}/approve`, {
                            approver: signers[role].address,
                          });
                        }}
                      >
                        Approve &amp; execute
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </Section>
  );
}

export function Operations({
  data,
  signers,
  onOpen,
}: {
  data: Data;
  signers: Record<Role, DemoSigner>;
  onOpen: (id: string) => void;
}) {
  return (
    <Section id="operations" title="Operations">
      {data.operations.length === 0 ? (
        <Empty title="No operations yet">
          Every action becomes an operation: a plan, its signatures and its
          settlement.
        </Empty>
      ) : (
        <ScrollRegion label="Operations">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Operation</th>
                <th>Signers</th>
                <th>Settlement</th>
                <th>Transaction</th>
                <th aria-label="Open" />
              </tr>
            </thead>
            <tbody>
              {data.operations.map((op: Operation) => {
                const status = STATUS[op.status] ?? {
                  label: op.status,
                  tone: "neutral" as const,
                };
                const signedBy = op.attempts.at(-1)?.signedBy ?? [];
                return (
                  <tr key={op.id}>
                    <td>{when(op.createdAt)}</td>
                    <td>
                      {KIND_LABELS[op.kind] ?? op.kind}
                      {op.origin === "chain" && (
                        <span className="tag">direct call</span>
                      )}
                    </td>
                    <td>
                      {op.requiredSigners.map((s) => (
                        <span
                          key={s}
                          className={
                            signedBy.includes(s) || op.status === "finalized"
                              ? "signer done"
                              : "signer"
                          }
                        >
                          {roleOf(signers, s)?.label ?? "External"}
                        </span>
                      ))}
                    </td>
                    <td>
                      <Badge tone={status.tone}>{status.label}</Badge>
                      {op.statusReason && (
                        <div className="fine">{op.statusReason}</div>
                      )}
                    </td>
                    <td>
                      <Id
                        value={
                          op.appliedSignature ?? op.attempts.at(-1)?.signature
                        }
                        size={6}
                      />
                    </td>
                    <td className="actions">
                      <button
                        type="button"
                        className="link"
                        onClick={() => onOpen(op.id)}
                      >
                        Review
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollRegion>
      )}
    </Section>
  );
}

export function StatementView({ data }: { data: Data }) {
  const { statement } = data;
  if (!statement) {
    return null;
  }
  return (
    <Section
      id="statement"
      title="Statement"
      aside={
        <Badge tone={statement.balanced ? "success" : "error"}>
          {statement.balanced ? "Balanced" : "Unbalanced"}
        </Badge>
      }
    >
      <div className="balances">
        {statement.balances.map((b: { account: string; balance: string }) => (
          <div key={b.account} className="balance">
            <span className="metric-label">
              {b.account.replaceAll("_", " ")}
            </span>
            <span className="numeric strong">
              {BigInt(b.balance) < 0n ? "Cr " : "Dr "}
              <Amount
                base={(BigInt(b.balance) < 0n
                  ? -BigInt(b.balance)
                  : BigInt(b.balance)
                ).toString()}
              />
            </span>
          </div>
        ))}
      </div>
      {statement.exceptions.length > 0 && (
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- block container with a heading; <output> is phrasing-only and inline
        <div className="exceptions" role="status">
          <h3>Reconciliation exceptions</h3>
          {statement.exceptions.map((e) => (
            <p key={e.id}>
              <Badge tone="error">{e.kind.replaceAll("_", " ")}</Badge>{" "}
              <Amount base={e.amount} /> in <Id value={e.signature} size={6} />{" "}
              — not applied to any loan; held in unallocated receipts.
            </p>
          ))}
        </div>
      )}
      <ScrollRegion label="Postings">
        <table>
          <thead>
            <tr>
              <th>Slot</th>
              <th>Entry</th>
              <th>Account</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th>Reference</th>
              <th>Signature</th>
            </tr>
          </thead>
          <tbody>
            {statement.postings.map((p) => (
              <tr key={p.id}>
                <td className="numeric">{p.slot}</td>
                <td>{p.entry.replaceAll("_", " ")}</td>
                <td>{p.account.replaceAll("_", " ")}</td>
                <td className="num">
                  {p.debit !== "0" && <Amount base={p.debit} unit={false} />}
                </td>
                <td className="num">
                  {p.credit !== "0" && <Amount base={p.credit} unit={false} />}
                </td>
                <td>{p.business_ref ?? "—"}</td>
                <td>
                  <Id value={p.signature} size={6} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollRegion>
    </Section>
  );
}

export function Events({ data }: { data: Data }) {
  return (
    <Section id="events" title="Webhook events">
      {data.events.length === 0 ? (
        <Empty title="No events yet">
          Finalized chain events and operation outcomes are written to a
          transactional outbox.
        </Empty>
      ) : (
        <ol className="events">
          {data.events
            .toReversed()
            .slice(0, 30)
            .map((e) => (
              <li key={e.id}>
                <span className="mono">{e.type}</span>
                <span className="fine">
                  {when(e.created_at)} ·{" "}
                  {e.delivered_at ? "delivered" : "queued"} · id{" "}
                  <Id value={e.event_id} size={10} />
                </span>
              </li>
            ))}
        </ol>
      )}
    </Section>
  );
}
