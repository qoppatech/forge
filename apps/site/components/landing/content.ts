// Landing copy and sample data. Figures follow the MVP demonstration in
// docs/FORGE-MVP-v0.1.md and the rules in programs/forge/src. Every sample is labeled on the page.

export const ASSET = "FORGE_TEST_USD";

export interface LedgerRow {
  step: string;
  vaultCash: string;
  outstanding: string;
  state: "Proposed" | "Approved" | "Active" | "Repaid" | null;
  approvals?: string;
}

export const lifecycle: {
  title: string;
  signer: string;
  body: string;
  instruction: string;
  ledger: LedgerRow;
}[] = [
  {
    body: "The treasury moves 10,000 test tokens into a vault whose mint, approvers, limits and withdrawal destination were fixed at creation.",
    instruction: "fund_vault",
    ledger: {
      outstanding: "0.00",
      state: null,
      step: "Funded",
      vaultCash: "10,000.00",
    },
    signer: "Treasury",
    title: "Fund the vault",
  },
  {
    body: "Principal 5,000 at 200 bps for the term. The fixed payoff of 5,100 is computed once and can never change.",
    instruction: "propose_loan",
    ledger: {
      approvals: "0 of 2",
      outstanding: "0.00",
      state: "Proposed",
      step: "Proposed",
      vaultCash: "10,000.00",
    },
    signer: "Approver A",
    title: "Propose the loan",
  },
  {
    body: "One approval is recorded. A draw attempted now is rejected by the program.",
    instruction: "approve_loan",
    ledger: {
      approvals: "1 of 2",
      outstanding: "0.00",
      state: "Proposed",
      step: "Approved once",
      vaultCash: "10,000.00",
    },
    signer: "Approver A",
    title: "First approval",
  },
  {
    body: "A second, distinct approver signs. Only now does the loan become eligible to draw before its offer expires.",
    instruction: "approve_loan",
    ledger: {
      approvals: "2 of 2",
      outstanding: "0.00",
      state: "Approved",
      step: "Approved",
      vaultCash: "10,000.00",
    },
    signer: "Approver B",
    title: "Second approval",
  },
  {
    body: "The named borrower draws to their own token account, inside the vault’s liquidity and outstanding-principal limits.",
    instruction: "draw_loan",
    ledger: {
      outstanding: "5,000.00",
      state: "Active",
      step: "Drawn",
      vaultCash: "5,000.00",
    },
    signer: "Borrower",
    title: "Draw",
  },
  {
    body: "The borrower repays the fixed payoff. Principal leaves the outstanding total; interest stays in the vault as cash.",
    instruction: "repay_loan",
    ledger: {
      outstanding: "0.00",
      state: "Repaid",
      step: "Repaid",
      vaultCash: "10,100.00",
    },
    signer: "Borrower",
    title: "Repay",
  },
];

export const principles = [
  {
    body: "Approvals, limits, expiry and pauses are enforced by the Solana program itself, not by an interface that could be bypassed.",
    title: "Controls live in the program",
  },
  {
    body: "Principal, rate, term, borrower and payoff are written once. Approvers sign exactly what was proposed.",
    title: "Terms are fixed at proposal",
  },
  {
    body: "Outstanding principal is tracked apart from vault cash. Withdrawals move only cash that is actually there.",
    title: "Cash and receivables stay separate",
  },
];

export const controls = [
  {
    body: "Set at vault creation and immutable. Each approves once; both are required.",
    code: "AlreadyApproved",
    title: "Two distinct approvers",
  },
  {
    body: "A proposal above the vault’s single-loan ceiling is rejected.",
    code: "PerLoanLimitExceeded",
    title: "Per-loan limit",
  },
  {
    body: "Draws cannot push total outstanding principal past the vault’s cap.",
    code: "OutstandingLimitExceeded",
    title: "Outstanding limit",
  },
  {
    body: "An approved offer that is not drawn in time can no longer disburse.",
    code: "LoanExpired",
    title: "Offer expiry",
  },
  {
    body: "Both approvers can stop new draws. Repayments keep working.",
    code: "DisbursementPaused",
    title: "Disbursement pause",
  },
  {
    body: "Principal goes only to the borrower’s account; withdrawals only to the fixed treasury account.",
    code: "InvalidDestination",
    title: "Bound destinations",
  },
];

export const status = {
  implemented: [
    "Anchor program with eight instructions",
    "Vault creation, funding and withdrawal",
    "Fixed-payoff loan lifecycle with two approvals",
    "Compiled-program tests in LiteSVM",
    "SDK package with IDL, types and program ID",
  ],
  notYet: [
    "Deployment to a validator or Devnet",
    "SDK transaction builders",
    "Banking API, reconciler and statements",
    "Operator and borrower interfaces",
    "Partial repayment, accrual and overdue handling",
  ],
};

export const faqs = [
  {
    a: "No. The program is built and tested against its compiled binary in LiteSVM. Local-validator and Devnet deployment are separate steps that have not been taken.",
    q: "Is FORGE deployed?",
  },
  {
    a: "No. FORGE is a sandbox. It uses FORGE_TEST_USD, a six-decimal fixture token with no redemption promise. Never fund it with assets of real value.",
    q: "Can it hold real assets?",
  },
  {
    a: "The legacy SPL Token program with one configured mint per vault. Token-2022 mints and substituted token programs are rejected.",
    q: "Which token program does it support?",
  },
  {
    a: "It is a fixed rate for the whole term, set in basis points at proposal. It is not an annual rate, and the payoff never accrues.",
    q: "What does the interest rate mean?",
  },
];

export const codeSamples = {
  rust: `pub fn propose_loan(
    ctx: Context<ProposeLoan>,
    loan_id: [u8; 32],
    principal: u64,
    term_rate_bps: u16,
    term_seconds: i64,
    offer_expiry: i64,
) -> Result<()>`,
  sh: `nix-shell
bash scripts/bootstrap.sh
bash scripts/build.sh
cargo test --locked -p forge`,
  ts: `import { FORGE_PROGRAM_ID, forgeIdl, type Forge } from '@forge/sdk';

// The SDK ships the IDL, its generated type and the program ID.
// Transaction builders are planned for a later milestone.
console.log(FORGE_PROGRAM_ID, forgeIdl.instructions.length);`,
};
