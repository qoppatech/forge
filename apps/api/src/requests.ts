import {
  decodeLoanAccount,
  decodeVaultAccount,
  decodeWithdrawalAccount,
  deriveOnchainId,
  findLoanAddress,
  findVaultAddress,
  findVaultTokenAddress,
  findWithdrawalAddress,
  loanView,
} from "@forge/sdk";
import type {
  ForgeIntent,
  LoanAccount,
  VaultAccount,
  WithdrawalAccount,
} from "@forge/sdk";
import { isAddress } from "@solana/kit";
import { z } from "zod";

import type { Institution } from "./auth";
import { parseTokenAccount } from "./chain";
import type { Chain } from "./chain";
import type { Db } from "./db";
import { conflict, HttpError, notFound } from "./http";
import { requestHash } from "./operations";
import type { Operations, OperationView } from "./operations";

const U64_MAX = 2n ** 64n - 1n;
const address = z
  .string()
  .refine((v) => isAddress(v), "must be a base58 address");
const isU64 = (v: string) =>
  /^\d+$/u.test(v) && BigInt(v) > 0n && BigInt(v) <= U64_MAX;
const amount = z
  .string()
  .refine(isU64, "must be a positive u64 integer string in base units");
const reference = z
  .string()
  .min(1)
  .max(64)
  // oxlint-disable-next-line require-unicode-regexp -- zod echoes this pattern (flags included) in validation error details
  .regex(/^[A-Za-z0-9._:-]+$/, "letters, digits and . _ : - only");

export const schemas = {
  approve: z.object({ approver: address }).strict(),
  createVault: z
    // oxlint-disable-next-line sort-keys -- shape order is the order of validation issues in error details
    .object({
      reference,
      treasury: address,
      mint: address,
      treasuryDestination: address,
      approvers: z.tuple([address, address]),
      perLoanLimit: amount,
      outstandingLimit: amount,
    })
    .strict()
    .refine(
      (b) => b.approvers[0] !== b.approvers[1],
      "approvers must be distinct"
    )
    .refine(
      (b) =>
        !isU64(b.perLoanLimit) ||
        !isU64(b.outstandingLimit) ||
        BigInt(b.perLoanLimit) <= BigInt(b.outstandingLimit),
      "perLoanLimit must not exceed outstandingLimit"
    ),
  draw: z.object({}).strict(),
  fundVault: z.object({ amount, source: address }).strict(),
  pause: z
    // oxlint-disable-next-line sort-keys -- shape order is the order of validation issues in error details
    .object({
      paused: z.boolean(),
      approverA: address.optional(),
      approverB: address.optional(),
    })
    .strict(),
  proposeLoan: z
    // oxlint-disable-next-line sort-keys -- shape order is the order of validation issues in error details
    .object({
      reference,
      approver: address,
      borrower: address,
      destination: address,
      principal: amount,
      termRateBps: z.number().int().min(0).max(10_000),
      termSeconds: z
        .string()
        .refine(
          (v) => /^\d+$/u.test(v) && BigInt(v) > 0n,
          "must be a positive integer string"
        ),
      // oxlint-disable-next-line require-unicode-regexp -- zod echoes this pattern (flags included) in validation error details
      offerExpiry: z.string().regex(/^\d+$/, "Unix timestamp in seconds"),
    })
    .strict(),
  proposeWithdrawal: z
    // oxlint-disable-next-line sort-keys -- shape order is the order of validation issues in error details
    .object({ reference, approver: address, amount })
    .strict(),
  repay: z.object({ borrowerTokens: address.optional() }).strict(),
};

/** Turns validated API requests into Forge intents. Checks here are advisory (UX only);
 *  the program re-checks every rule for any caller. */
export class Requests {
  private readonly db: Db;
  private readonly chain: Chain;
  private readonly operations: Operations;

  constructor(db: Db, chain: Chain, operations: Operations) {
    this.db = db;
    this.chain = chain;
    this.operations = operations;
  }

  private async account<T>(
    accountAddress: string,
    decode: (data: Uint8Array) => T
  ): Promise<T | null> {
    const [snapshot] = await this.chain.getAccounts(
      [accountAddress],
      "confirmed"
    );
    return snapshot ? decode(snapshot.data) : null;
  }

  private async chainVault(vault: string): Promise<VaultAccount> {
    const account = await this.account(vault, decodeVaultAccount);
    if (!account) {
      throw conflict(
        "not_on_chain",
        "Vault is not on chain yet (wait for confirmation)"
      );
    }
    return account;
  }

  private async chainLoan(loan: string): Promise<LoanAccount> {
    const account = await this.account(loan, decodeLoanAccount);
    if (!account) {
      throw conflict(
        "not_on_chain",
        "Loan is not on chain yet (wait for confirmation)"
      );
    }
    return account;
  }

  private async chainWithdrawal(
    withdrawal: string
  ): Promise<WithdrawalAccount> {
    const account = await this.account(withdrawal, decodeWithdrawalAccount);
    if (!account) {
      throw conflict(
        "not_on_chain",
        "Withdrawal is not on chain yet (wait for confirmation)"
      );
    }
    return account;
  }

  private async ownedVault(institution: Institution, vault: string) {
    const [row] = await this.db`
      SELECT * FROM vaults WHERE address = ${vault} AND institution_id = ${institution.id}`;
    if (!row) {
      throw notFound("Vault");
    }
    return row as { address: string; vault_ref: string };
  }

  private async ownedChild(
    institution: Institution,
    table: "loans" | "withdrawals",
    childAddress: string
  ) {
    const rows =
      table === "loans"
        ? await this
            .db`SELECT l.vault FROM loans l JOIN vaults v ON v.address = l.vault
                        WHERE l.address = ${childAddress} AND v.institution_id = ${institution.id}`
        : await this
            .db`SELECT w.vault FROM withdrawals w JOIN vaults v ON v.address = w.vault
                        WHERE w.address = ${childAddress} AND v.institution_id = ${institution.id}`;
    if (!rows[0]) {
      throw notFound(table === "loans" ? "Loan" : "Withdrawal");
    }
    return rows[0].vault as string;
  }

  private create(
    institution: Institution,
    key: string,
    route: string,
    body: unknown,
    intent: ForgeIntent,
    display: Record<string, string>,
    register?: (tx: Db) => Promise<void>
  ): Promise<{ created: boolean; operation: OperationView }> {
    return requestHash(route, body).then((hash) =>
      this.operations.create({
        display,
        idempotencyKey: key,
        institution,
        intent,
        register,
        requestHash: hash,
      })
    );
  }

  async createVault(
    institution: Institution,
    key: string,
    body: z.infer<typeof schemas.createVault>
  ) {
    const vaultId = await deriveOnchainId(
      "vault",
      institution.id,
      body.reference
    );
    const vault = await findVaultAddress(body.treasury as never, vaultId);
    const vaultTokenAccount = await findVaultTokenAddress(vault);
    const [sameRef] = await this.db`
      SELECT address FROM vaults WHERE institution_id = ${institution.id} AND vault_ref = ${body.reference}`;
    if (sameRef && sameRef.address !== vault) {
      throw conflict(
        "reference_conflict",
        "Vault reference already names a different vault"
      );
    }
    const intent: ForgeIntent = {
      approvers: body.approvers,
      kind: "create_vault",
      mint: body.mint,
      outstandingLimit: body.outstandingLimit,
      perLoanLimit: body.perLoanLimit,
      treasury: body.treasury,
      treasuryDestination: body.treasuryDestination,
      vault,
      vaultId,
      vaultTokenAccount,
    };
    return this.create(
      institution,
      key,
      "create_vault",
      body,
      intent,
      {
        outstandingLimit: body.outstandingLimit,
        perLoanLimit: body.perLoanLimit,
        reference: body.reference,
      },
      async (tx) => {
        await tx`
        INSERT INTO vaults (address, institution_id, vault_ref, vault_id, treasury, mint, token_account,
          treasury_destination, approvers, per_loan_limit, outstanding_limit)
        VALUES (${vault}, ${institution.id}, ${body.reference}, ${vaultId}, ${body.treasury}, ${body.mint},
          ${vaultTokenAccount}, ${body.treasuryDestination}, ${body.approvers}, ${body.perLoanLimit},
          ${body.outstandingLimit})
        ON CONFLICT DO NOTHING`;
      }
    );
  }

  async fundVault(
    institution: Institution,
    key: string,
    vault: string,
    body: z.infer<typeof schemas.fundVault>
  ) {
    await this.ownedVault(institution, vault);
    const account = await this.chainVault(vault);
    const intent: ForgeIntent = {
      amount: body.amount,
      kind: "fund_vault",
      mint: account.mint,
      source: body.source,
      treasury: account.treasury,
      vault,
      vaultTokenAccount: account.tokenAccount,
    };
    return this.create(institution, key, `fund_vault:${vault}`, body, intent, {
      amount: body.amount,
    });
  }

  async proposeLoan(
    institution: Institution,
    key: string,
    vault: string,
    body: z.infer<typeof schemas.proposeLoan>
  ) {
    await this.ownedVault(institution, vault);
    const account = await this.chainVault(vault);
    if (!account.approvers.includes(body.approver)) {
      throw new HttpError(
        422,
        "not_an_approver",
        "Approver is not configured on this vault"
      );
    }
    if (BigInt(body.principal) > account.perLoanLimit) {
      throw new HttpError(
        422,
        "per_loan_limit",
        "Principal exceeds the vault's per-loan limit"
      );
    }
    if (BigInt(body.offerExpiry) <= BigInt(Math.floor(Date.now() / 1000))) {
      throw new HttpError(
        422,
        "offer_expiry",
        "Offer expiry must be in the future"
      );
    }
    const [destination] = await this.chain.getAccounts(
      [body.destination],
      "confirmed"
    );
    const token = destination ? parseTokenAccount(destination.data) : null;
    if (
      !token ||
      token.owner !== body.borrower ||
      token.mint !== account.mint
    ) {
      throw new HttpError(
        422,
        "invalid_destination",
        "Destination must be the borrower's token account for the vault mint"
      );
    }
    const loanId = await deriveOnchainId("loan", vault, body.reference);
    const loan = await findLoanAddress(vault as never, loanId);
    const interest =
      (BigInt(body.principal) * BigInt(body.termRateBps)) / 10_000n;
    const intent: ForgeIntent = {
      approver: body.approver,
      borrower: body.borrower,
      destination: body.destination,
      kind: "propose_loan",
      loan,
      loanId,
      mint: account.mint,
      offerExpiry: body.offerExpiry,
      principal: body.principal,
      termRateBps: body.termRateBps,
      termSeconds: body.termSeconds,
      vault,
    };
    return this.create(
      institution,
      key,
      `propose_loan:${vault}`,
      body,
      intent,
      {
        interest: interest.toString(),
        payoff: (BigInt(body.principal) + interest).toString(),
        principal: body.principal,
        reference: body.reference,
      },
      async (tx) => {
        await tx`
        INSERT INTO loans (address, vault, loan_ref, loan_id, borrower, destination, principal,
          term_rate_bps, term_seconds, offer_expiry)
        VALUES (${loan}, ${vault}, ${body.reference}, ${loanId}, ${body.borrower}, ${body.destination},
          ${body.principal}, ${body.termRateBps}, ${body.termSeconds}, ${body.offerExpiry})
        ON CONFLICT DO NOTHING`;
      }
    );
  }

  async approveLoan(
    institution: Institution,
    key: string,
    loan: string,
    body: z.infer<typeof schemas.approve>
  ) {
    const vault = await this.ownedChild(institution, "loans", loan);
    const [vaultAccount, loanAccount] = [
      await this.chainVault(vault),
      await this.chainLoan(loan),
    ];
    const index = vaultAccount.approvers.indexOf(body.approver);
    if (index === -1) {
      throw new HttpError(
        422,
        "not_an_approver",
        "Approver is not configured on this vault"
      );
    }
    if (loanAccount.state !== "Proposed") {
      throw conflict("invalid_state", `Loan is ${loanAccount.state}`);
    }
    if (loanAccount.approvals[index]) {
      throw conflict("already_approved", "This approver already approved");
    }
    const intent: ForgeIntent = {
      approver: body.approver,
      kind: "approve_loan",
      loan,
      vault,
    };
    return this.create(institution, key, `approve_loan:${loan}`, body, intent, {
      borrower: loanAccount.borrower,
      payoff: loanAccount.fixedPayoff.toString(),
      principal: loanAccount.principal.toString(),
    });
  }

  async drawLoan(
    institution: Institution,
    key: string,
    loan: string,
    body: z.infer<typeof schemas.draw>
  ) {
    const vault = await this.ownedChild(institution, "loans", loan);
    const [vaultAccount, loanAccount] = [
      await this.chainVault(vault),
      await this.chainLoan(loan),
    ];
    const view = loanView(loanAccount, BigInt(Math.floor(Date.now() / 1000)));
    if (view.status !== "approved") {
      throw conflict("invalid_state", `Loan is ${view.status}`);
    }
    if (vaultAccount.disbursementPaused) {
      throw conflict("paused", "Disbursement is paused");
    }
    const intent: ForgeIntent = {
      borrower: loanAccount.borrower,
      destination: loanAccount.destination,
      kind: "draw_loan",
      loan,
      mint: vaultAccount.mint,
      vault,
      vaultTokenAccount: vaultAccount.tokenAccount,
    };
    return this.create(institution, key, `draw_loan:${loan}`, body, intent, {
      payoff: loanAccount.fixedPayoff.toString(),
      principal: loanAccount.principal.toString(),
      termSeconds: loanAccount.termSeconds.toString(),
    });
  }

  async repayLoan(
    institution: Institution,
    key: string,
    loan: string,
    body: z.infer<typeof schemas.repay>
  ) {
    const vault = await this.ownedChild(institution, "loans", loan);
    const [vaultAccount, loanAccount] = [
      await this.chainVault(vault),
      await this.chainLoan(loan),
    ];
    if (loanAccount.state !== "Active") {
      throw conflict("invalid_state", `Loan is ${loanAccount.state}`);
    }
    const intent: ForgeIntent = {
      borrower: loanAccount.borrower,
      borrowerTokens: body.borrowerTokens ?? loanAccount.destination,
      kind: "repay_loan",
      loan,
      mint: vaultAccount.mint,
      vault,
      vaultTokenAccount: vaultAccount.tokenAccount,
    };
    return this.create(institution, key, `repay_loan:${loan}`, body, intent, {
      payoff: loanAccount.fixedPayoff.toString(),
      principal: loanAccount.principal.toString(),
    });
  }

  async proposeWithdrawal(
    institution: Institution,
    key: string,
    vault: string,
    body: z.infer<typeof schemas.proposeWithdrawal>
  ) {
    await this.ownedVault(institution, vault);
    const account = await this.chainVault(vault);
    if (!account.approvers.includes(body.approver)) {
      throw new HttpError(
        422,
        "not_an_approver",
        "Approver is not configured on this vault"
      );
    }
    const withdrawalId = await deriveOnchainId(
      "withdrawal",
      vault,
      body.reference
    );
    const withdrawal = await findWithdrawalAddress(
      vault as never,
      withdrawalId
    );
    const intent: ForgeIntent = {
      amount: body.amount,
      approver: body.approver,
      kind: "propose_withdrawal",
      vault,
      withdrawal,
      withdrawalId,
    };
    return this.create(
      institution,
      key,
      `propose_withdrawal:${vault}`,
      body,
      intent,
      {
        amount: body.amount,
        destination: account.treasuryDestination,
        reference: body.reference,
      },
      async (tx) => {
        await tx`
        INSERT INTO withdrawals (address, vault, withdrawal_ref, withdrawal_id, amount)
        VALUES (${withdrawal}, ${vault}, ${body.reference}, ${withdrawalId}, ${body.amount})
        ON CONFLICT DO NOTHING`;
      }
    );
  }

  async approveWithdrawal(
    institution: Institution,
    key: string,
    withdrawal: string,
    body: z.infer<typeof schemas.approve>
  ) {
    const vault = await this.ownedChild(institution, "withdrawals", withdrawal);
    const [vaultAccount, account] = [
      await this.chainVault(vault),
      await this.chainWithdrawal(withdrawal),
    ];
    const index = vaultAccount.approvers.indexOf(body.approver);
    if (index === -1) {
      throw new HttpError(
        422,
        "not_an_approver",
        "Approver is not configured on this vault"
      );
    }
    if (account.state !== "Proposed") {
      throw conflict("invalid_state", `Withdrawal is ${account.state}`);
    }
    if (account.approvals[index]) {
      throw conflict("already_approved", "This approver already approved");
    }
    const intent: ForgeIntent = {
      approver: body.approver,
      kind: "approve_withdrawal",
      mint: vaultAccount.mint,
      treasuryDestination: vaultAccount.treasuryDestination,
      vault,
      vaultTokenAccount: vaultAccount.tokenAccount,
      withdrawal,
    };
    return this.create(
      institution,
      key,
      `approve_withdrawal:${withdrawal}`,
      body,
      intent,
      {
        amount: account.amount.toString(),
        destination: vaultAccount.treasuryDestination,
      }
    );
  }

  async setPause(
    institution: Institution,
    key: string,
    vault: string,
    body: z.infer<typeof schemas.pause>
  ) {
    await this.ownedVault(institution, vault);
    const account = await this.chainVault(vault);
    const [approverA = account.approvers[0], approverB = account.approvers[1]] =
      [body.approverA, body.approverB];
    const intent: ForgeIntent = {
      approverA,
      approverB,
      expectedSeq: account.pauseSeq.toString(),
      kind: "set_disbursement_paused",
      paused: body.paused,
      vault,
    };
    return this.create(
      institution,
      key,
      `set_disbursement_paused:${vault}`,
      body,
      intent,
      {
        currentlyPaused: String(account.disbursementPaused),
        pauseSeq: account.pauseSeq.toString(),
        paused: String(body.paused),
      }
    );
  }
}
