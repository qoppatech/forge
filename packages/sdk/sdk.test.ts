/// <reference types="bun" />
import { describe, expect, test } from "bun:test";

import {
  AccountRole,
  appendTransactionMessageInstruction,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
} from "@solana/kit";
import type { Transaction } from "@solana/kit";

import type * as Sdk from "./src/index.js";

const root = new URL("../../", import.meta.url);
const entry = new URL("dist/index.js", import.meta.url);
const sdk = (await import(entry.href)) as typeof Sdk;
const artifact = await Bun.file(new URL("target/idl/forge.json", root)).json();

const BLOCKHASH = "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N";
const lifetime = { blockhash: BLOCKHASH, lastValidBlockHeight: 1000n };

async function newAddress() {
  const pair = await generateKeyPair();
  return { address: await getAddressFromPublicKey(pair.publicKey), pair };
}

/** Narrows away `undefined`, failing the test instead of passing it through. */
function defined<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected a value, got undefined");
  }
  return value;
}

const customError = (code: number | bigint) => ({
  InstructionError: [0, { Custom: code }],
});

async function sampleIntents() {
  const keys = await Promise.all(Array.from({ length: 10 }, newAddress));
  const addressAt = (index: number) => defined(keys[index]).address;
  const treasury = addressAt(0);
  const a = addressAt(1);
  const b = addressAt(2);
  const borrower = addressAt(3);
  const mint = addressAt(4);
  const source = addressAt(5);
  const dest = addressAt(6);
  const tdest = addressAt(7);
  const vaultId = await sdk.deriveOnchainId("vault", "inst-1", "main");
  const vault = await sdk.findVaultAddress(treasury as never, vaultId);
  const tokens = await sdk.findVaultTokenAddress(vault);
  const loanId = await sdk.deriveOnchainId("loan", vault, "LN-1");
  const loan = await sdk.findLoanAddress(vault, loanId);
  const withdrawalId = await sdk.deriveOnchainId("withdrawal", vault, "WD-1");
  const withdrawal = await sdk.findWithdrawalAddress(vault, withdrawalId);
  const intents: Sdk.ForgeIntent[] = [
    {
      approvers: [a, b],
      kind: "create_vault",
      mint,
      outstandingLimit: "10000000000",
      perLoanLimit: "5000000000",
      treasury,
      treasuryDestination: tdest,
      vault,
      vaultId,
      vaultTokenAccount: tokens,
    },
    {
      amount: "10000000000",
      kind: "fund_vault",
      mint,
      source,
      treasury,
      vault,
      vaultTokenAccount: tokens,
    },
    {
      approver: a,
      borrower,
      destination: dest,
      kind: "propose_loan",
      loan,
      loanId,
      mint,
      offerExpiry: "1900000000",
      principal: "5000000000",
      termRateBps: 200,
      termSeconds: "2592000",
      vault,
    },
    { approver: b, kind: "approve_loan", loan, vault },
    {
      borrower,
      destination: dest,
      kind: "draw_loan",
      loan,
      mint,
      vault,
      vaultTokenAccount: tokens,
    },
    {
      borrower,
      borrowerTokens: dest,
      kind: "repay_loan",
      loan,
      mint,
      vault,
      vaultTokenAccount: tokens,
    },
    {
      amount: "100000000",
      approver: a,
      kind: "propose_withdrawal",
      vault,
      withdrawal,
      withdrawalId,
    },
    {
      approver: b,
      kind: "approve_withdrawal",
      mint,
      treasuryDestination: tdest,
      vault,
      vaultTokenAccount: tokens,
      withdrawal,
    },
    {
      approverA: a,
      approverB: b,
      expectedSeq: "3",
      kind: "set_disbursement_paused",
      paused: true,
      vault,
    },
  ];
  return { intents, keys };
}

describe("IDL packaging and drift", () => {
  test("packaged IDL equals the built program IDL", () => {
    expect(sdk.forgeIdl).toEqual(artifact);
    expect(sdk.FORGE_PROGRAM_ID).toBe(artifact.address);
    expect(sdk.FORGE_PROGRAM_ADDRESS).toBe(artifact.address);
  });

  test("every IDL instruction has exactly one intent mapping covering all accounts and args", () => {
    const names = artifact.instructions
      .map((ix: { name: string }) => ix.name)
      .toSorted();
    expect(sdk.INTENT_KINDS.toSorted()).toEqual(names);
    for (const ix of artifact.instructions) {
      const spec = sdk.INTENT_SPECS[ix.name as keyof typeof sdk.INTENT_SPECS];
      const variable = ix.accounts
        .filter((a: { address?: string }) => !a.address)
        .map((a: { name: string }) => a.name);
      expect(Object.keys(spec.accounts).toSorted()).toEqual(
        variable.toSorted()
      );
      expect(Object.keys(spec.args).toSorted()).toEqual(
        ix.args.map((a: { name: string }) => a.name).toSorted()
      );
      for (const signer of ix.accounts.filter(
        (a: { signer?: boolean }) => a.signer
      )) {
        expect(spec.signers).toContain(defined(spec.accounts[signer.name]));
      }
    }
  });

  test("PDA helpers use the IDL's constant seed prefixes", () => {
    const prefixes = new Map<string, string>();
    for (const ix of artifact.instructions) {
      for (const account of ix.accounts) {
        const first = account.pda?.seeds?.[0];
        if (first?.kind === "const") {
          prefixes.set(account.name, String.fromCodePoint(...first.value));
        }
      }
    }
    expect(prefixes.get("vault")).toBe("vault");
    expect(prefixes.get("vault_token_account")).toBe("tokens");
    expect(prefixes.get("loan")).toBe("loan");
    expect(prefixes.get("withdrawal")).toBe("withdrawal");
  });
});

describe("instruction codec", () => {
  test("every intent round-trips through the encoded instruction with IDL roles", async () => {
    const { intents } = await sampleIntents();
    for (const intent of intents) {
      const ix = sdk.buildForgeInstruction(intent);
      const idlIx = artifact.instructions.find(
        (i: { name: string }) => i.name === intent.kind
      );
      const data = defined(ix.data);
      const accounts = defined(ix.accounts);
      expect([...data.subarray(0, 8)]).toEqual(idlIx.discriminator);
      for (const [i, meta] of accounts.entries()) {
        const expected = idlIx.accounts[i];
        const signer =
          meta.role === AccountRole.READONLY_SIGNER ||
          meta.role === AccountRole.WRITABLE_SIGNER;
        const writable =
          meta.role === AccountRole.WRITABLE ||
          meta.role === AccountRole.WRITABLE_SIGNER;
        expect(signer).toBe(Boolean(expected.signer));
        expect(writable).toBe(Boolean(expected.writable));
        if (expected.address) {
          expect(meta.address).toBe(expected.address);
        }
      }
      const decoded = sdk.decodeForgeInstruction({
        accounts,
        data: new Uint8Array(data),
        programAddress: ix.programAddress,
      });
      expect(sdk.intentsEqual(decoded, intent)).toBe(true);
    }
  });

  test("out-of-range and malformed values are rejected rather than mis-encoded", async () => {
    const { intents } = await sampleIntents();
    const fund = intents[1] as Sdk.FundVaultIntent;
    expect(() =>
      sdk.buildForgeInstruction({ ...fund, amount: "18446744073709551616" })
    ).toThrow();
    expect(() =>
      sdk.buildForgeInstruction({ ...fund, amount: "-1" })
    ).toThrow();
    expect(() =>
      sdk.buildForgeInstruction({ ...fund, amount: "1.5" })
    ).toThrow();
    const vault = intents[0] as Sdk.CreateVaultIntent;
    expect(() =>
      sdk.buildForgeInstruction({ ...vault, vaultId: "abcd" })
    ).toThrow();
  });

  test("required signers put the fee payer first; pause needs both approvers", async () => {
    const { intents } = await sampleIntents();
    const pause = intents[8] as Sdk.SetDisbursementPausedIntent;
    expect(sdk.requiredSigners(pause)).toEqual([
      pause.approverA,
      pause.approverB,
    ]);
    expect(sdk.intentSubject(defined(intents[2]))).toBe(
      (intents[2] as { loan: string }).loan
    );
  });
});

describe("plans, signing and verification", () => {
  test("a compiled plan verifies against its intent and detects tampering", async () => {
    const { intents } = await sampleIntents();
    await Promise.all(
      intents.map(async (intent) => {
        const tx = sdk.compileIntentTransaction(intent, lifetime);
        const plan = {
          intent,
          messageHash: await sdk.messageHash(tx),
          requiredSigners: sdk.requiredSigners(intent),
          transaction: sdk.encodeWireTransaction(tx),
        };
        expect(await sdk.verifyPlan(plan)).toEqual([]);
        const inspected = sdk.inspectTransaction(tx);
        expect(inspected.feePayer).toBe(
          defined(sdk.requiredSigners(intent)[0])
        );
        expect(inspected.blockhash).toBe(BLOCKHASH);
      })
    );
    const fund = intents[1] as Sdk.FundVaultIntent;
    const tx = sdk.compileIntentTransaction(fund, lifetime);
    const plan = {
      intent: fund,
      messageHash: await sdk.messageHash(tx),
      requiredSigners: sdk.requiredSigners(fund),
      transaction: sdk.encodeWireTransaction(tx),
    };
    // The signer asked for 1 token; a plan for 10,000 must fail review.
    expect(
      await sdk.verifyPlan(plan, { ...fund, amount: "1000000" })
    ).toContain("Encoded instruction does not match the intent");
    expect(await sdk.verifyPlan({ ...plan, messageHash: "00" })).toContain(
      "Message hash mismatch"
    );
  });

  test("an extra instruction in the bytes fails review", async () => {
    const { intents } = await sampleIntents();
    const fund = defined(intents[1]);
    const extra = sdk.buildForgeInstruction(defined(intents[0]));
    const tx = sdk.compileIntentTransaction(fund, lifetime);
    const msg = sdk.inspectTransaction(tx);
    expect(msg.instructions).toHaveLength(1);
    const {
      compileTransaction,
      createTransactionMessage,
      pipe,
      setTransactionMessageFeePayer,
      setTransactionMessageLifetimeUsingBlockhash,
      address,
    } = await import("@solana/kit");
    const tampered = compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) =>
          setTransactionMessageFeePayer(
            address(defined(sdk.requiredSigners(fund)[0])),
            m
          ),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1n },
            m
          ),
        (m) =>
          appendTransactionMessageInstruction(
            sdk.buildForgeInstruction(fund),
            m
          ),
        (m) => appendTransactionMessageInstruction(extra, m)
      )
    );
    const problems = await sdk.verifyPlan({
      intent: fund,
      messageHash: await sdk.messageHash(tampered),
      requiredSigners: sdk.requiredSigners(fund),
      transaction: getBase64EncodedWireTransaction(tampered),
    });
    expect(problems.some((p) => p.startsWith("Expected 1 instruction"))).toBe(
      true
    );
  });

  test("operation memos make identical intents distinct transactions and are verified", async () => {
    const { intents } = await sampleIntents();
    const fund = defined(intents[1]);
    const plain = sdk.compileIntentTransaction(fund, lifetime);
    const twin = sdk.compileIntentTransaction(fund, lifetime);
    // Same intent + same blockhash = the same message, hence one transaction id on chain.
    expect(await sdk.messageHash(plain)).toBe(await sdk.messageHash(twin));
    const id = crypto.randomUUID();
    const memoA = sdk.operationMemo(id, 1);
    const memoB = sdk.operationMemo(crypto.randomUUID(), 1);
    const a = sdk.compileIntentTransaction(fund, lifetime, { memo: memoA });
    const b = sdk.compileIntentTransaction(fund, lifetime, { memo: memoB });
    expect(await sdk.messageHash(a)).not.toBe(await sdk.messageHash(b));
    expect(sdk.parseOperationMemo(memoA)).toEqual({
      attemptNo: 1,
      operationId: id,
    });
    expect(sdk.parseOperationMemo("hello")).toBeUndefined();
    const inspected = sdk.inspectTransaction(a);
    expect(
      inspected.instructions.map((ix) => ix.memo ?? ix.intent?.kind)
    ).toEqual([memoA, "fund_vault"]);
    const plan = {
      intent: fund,
      memo: memoA,
      messageHash: await sdk.messageHash(a),
      requiredSigners: sdk.requiredSigners(fund),
      transaction: sdk.encodeWireTransaction(a),
    };
    expect(await sdk.verifyPlan(plan)).toEqual([]);
    expect(await sdk.verifyPlan({ ...plan, memo: memoB })).toContain(
      "Operation memo is missing or differs from the plan"
    );
  });

  test("partial signatures merge; altered messages and forged signatures are rejected", async () => {
    const a = await newAddress();
    const b = await newAddress();
    const { intents } = await sampleIntents();
    const pause = {
      ...(intents[8] as Sdk.SetDisbursementPausedIntent),
      approverA: a.address,
      approverB: b.address,
    };
    const stored = sdk.compileIntentTransaction(pause, lifetime);
    const unsigned = sdk.encodeWireTransaction(stored);

    const signedByA = await sdk.signPlanTransaction(unsigned, [a.pair]);
    const first = await sdk.mergeSignatures(
      stored,
      sdk.decodeWireTransaction(signedByA)
    );
    expect(first.added).toEqual([a.address]);
    expect(sdk.isFullySigned(first.transaction)).toBe(false);

    const signedByB = await sdk.signPlanTransaction(unsigned, [b.pair]);
    const second = await sdk.mergeSignatures(
      first.transaction,
      sdk.decodeWireTransaction(signedByB)
    );
    expect(second.added).toEqual([b.address]);
    expect(sdk.isFullySigned(second.transaction)).toBe(true);
    const checks = await sdk.checkSignatures(second.transaction);
    expect(checks.every((c) => c.status === "valid")).toBe(true);
    expect(sdk.transactionSignature(second.transaction)).toBeString();

    // Re-submitting the same signature is idempotent.
    const again = await sdk.mergeSignatures(
      second.transaction,
      sdk.decodeWireTransaction(signedByA)
    );
    expect(again.added).toEqual([]);

    // A signature over different bytes (new blockhash) is rejected.
    const other = sdk.compileIntentTransaction(pause, {
      ...lifetime,
      blockhash: "11111111111111111111111111111111",
    });
    const otherSigned = await sdk.signPlanTransaction(
      sdk.encodeWireTransaction(other),
      [a.pair]
    );
    await expect(
      sdk.mergeSignatures(stored, sdk.decodeWireTransaction(otherSigned))
    ).rejects.toThrow("differs");

    // A forged signature slot is rejected.
    const forged: Transaction = {
      ...sdk.decodeWireTransaction(signedByA),
      signatures: {
        ...stored.signatures,
        [b.address]: new Uint8Array(64).fill(7),
      },
    } as Transaction;
    await expect(sdk.mergeSignatures(stored, forged)).rejects.toThrow(
      "Invalid signature"
    );
  });
});

describe("errors, accounts and views", () => {
  test("transaction errors are classified for reconciliation", () => {
    expect(sdk.decodeTransactionError(customError(6010)).category).toBe(
      "replay"
    );
    expect(sdk.decodeTransactionError(customError(6011)).name).toBe(
      "AlreadyApproved"
    );
    expect(sdk.decodeTransactionError(customError(6018n)).name).toBe(
      "InvalidWithdrawalState"
    );
    expect(sdk.decodeTransactionError(customError(6015)).category).toBe(
      "rejected"
    );
    expect(sdk.decodeTransactionError(customError(6019)).name).toBe(
      "StalePauseSequence"
    );
    expect(sdk.decodeTransactionError(customError(6004)).category).toBe(
      "unauthorized"
    );
    expect(sdk.decodeTransactionError(customError(2012)).name).toBe(
      "ConstraintAddress"
    );
    expect(
      sdk.decodeTransactionError(customError(0), ["propose_loan"])
    ).toMatchObject({
      category: "replay",
      name: "AccountAlreadyInUse",
    });
    expect(
      sdk.decodeTransactionError(customError(1), ["repay_loan"])
    ).toMatchObject({
      category: "token",
      name: "InsufficientFunds",
    });
    expect(sdk.decodeTransactionError("BlockhashNotFound").category).toBe(
      "transaction"
    );
  });

  test("account decoders read IDL layouts", async () => {
    const { encodeWithDiscriminator } = await import("./src/codec.js");
    const { idl, idlTypeDef } = await import("./src/idl.js");
    const def = idlTypeDef("Withdrawal");
    if (def.type.kind !== "struct") {
      throw new Error("struct expected");
    }
    const { address: vault } = await newAddress();
    const { discriminator: disc } = defined(
      idl.accounts.find((a) => a.name === "Withdrawal")
    );
    const data = encodeWithDiscriminator(disc, def.type.fields, {
      amount: 42n,
      approvals: [true, false],
      bump: 254,
      executed_at: 0n,
      proposed_at: 10n,
      state: "Proposed",
      vault,
      withdrawal_id: new Uint8Array(32).fill(1),
    });
    const decoded = sdk.decodeWithdrawalAccount(data);
    expect(decoded).toMatchObject({
      amount: 42n,
      approvals: [true, false],
      bump: 254,
      state: "Proposed",
      vault,
    });
    expect(decoded.withdrawalId).toBe("01".repeat(32));
    expect(sdk.decodeForgeAccount(data)?.type).toBe("Withdrawal");
    expect(() => sdk.decodeVaultAccount(data)).toThrow();
  });

  test("loan views compute expiry and overdue without stored states", () => {
    const base = { disbursedAt: 0n, offerExpiry: 100n, termSeconds: 50n };
    expect(sdk.loanView({ ...base, state: "Approved" }, 100n).status).toBe(
      "approved"
    );
    expect(sdk.loanView({ ...base, state: "Approved" }, 101n).status).toBe(
      "offer_expired"
    );
    expect(
      sdk.loanView({ ...base, disbursedAt: 10n, state: "Active" }, 60n)
    ).toEqual({ dueAt: 60n, status: "active" });
    expect(
      sdk.loanView({ ...base, disbursedAt: 10n, state: "Active" }, 61n).status
    ).toBe("overdue");
    expect(
      sdk.loanView({ ...base, disbursedAt: 10n, state: "Repaid" }, 999n).status
    ).toBe("repaid");
  });

  test("token amounts parse and format in integer base units", () => {
    expect(sdk.parseTokenAmount("10000")).toBe(10_000_000_000n);
    expect(sdk.parseTokenAmount("0.000001")).toBe(1n);
    expect(() => sdk.parseTokenAmount("0.0000001")).toThrow();
    expect(sdk.formatTokenAmount(10_100_000_000n)).toBe("10,100.000000");
  });

  test("JSON-safe conversion keeps bigints, bytes and timestamps", () => {
    const at = new Date("2026-10-05T12:00:00.000Z");
    expect(
      sdk.toJsonSafe({ at, bytes: new Uint8Array([1, 255]), n: 2n ** 64n - 1n })
    ).toEqual({
      at: "2026-10-05T12:00:00.000Z",
      bytes: "01ff",
      n: "18446744073709551615",
    });
  });

  test("on-chain ids are deterministic per scope and reference", async () => {
    const a = await sdk.deriveOnchainId("loan", "vault-1", "LN-1");
    expect(a).toHaveLength(64);
    expect(await sdk.deriveOnchainId("loan", "vault-1", "LN-1")).toBe(a);
    expect(await sdk.deriveOnchainId("loan", "vault-2", "LN-1")).not.toBe(a);
    expect(await sdk.deriveOnchainId("withdrawal", "vault-1", "LN-1")).not.toBe(
      a
    );
  });
});

describe("untrusted chain data (security audit regressions)", () => {
  test("operation memos accept only a canonical UUID and a bounded attempt number", () => {
    const id = crypto.randomUUID();
    expect(sdk.parseOperationMemo(`forge:op:${id}:2`)).toEqual({
      attemptNo: 2,
      operationId: id,
    });
    for (const memo of [
      `forge:op:${"-".repeat(36)}:1`,
      `forge:op:${"a".repeat(36)}:1`,
      `forge:op:${id}:0`,
      `forge:op:${id}:9999999999`,
      `forge:op:${id.toUpperCase()}:1`,
    ]) {
      expect(sdk.parseOperationMemo(memo)).toBeUndefined();
    }
  });

  test("executed instructions decode like the program: trailing bytes are ignored only on request", async () => {
    const { intents } = await sampleIntents();
    const fund = defined(intents[1]);
    const ix = sdk.buildForgeInstruction(fund);
    const padded = {
      accounts: ix.accounts ?? [],
      data: new Uint8Array([...(ix.data ?? []), 0xde, 0xad]),
      programAddress: ix.programAddress,
    };
    expect(() => sdk.decodeForgeInstruction(padded)).toThrow(
      "Trailing bytes after Borsh data"
    );
    expect(sdk.decodeForgeInstruction(padded, { exact: false })).toEqual(fund);
  });

  test("error decoding survives bigint payloads from the RPC", () => {
    const decoded = sdk.decodeTransactionError({
      InsufficientFundsForRent: { account_index: 3n },
    });
    expect(decoded.category).toBe("unknown");
    expect(decoded.message).toContain('"3"');
    expect(
      sdk.decodeTransactionError({
        InstructionError: [0, { BorshIoError: 7n }],
      }).category
    ).toBe("invalid_accounts");
  });

  test("a v1 plan with a priority-fee config fails review even when every field matches", async () => {
    const { intents } = await sampleIntents();
    const fund = defined(intents[1]) as Sdk.FundVaultIntent;
    const memo = sdk.operationMemo(crypto.randomUUID(), 1);
    const {
      address,
      compileTransaction,
      createTransactionMessage,
      pipe,
      setTransactionMessageFeePayer,
      setTransactionMessageLifetimeUsingBlockhash,
      setTransactionMessagePriorityFeeLamports,
    } = await import("@solana/kit");
    const v1 = compileTransaction(
      pipe(
        createTransactionMessage({ version: 1 }),
        (m) => setTransactionMessageFeePayer(address(fund.treasury), m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: BLOCKHASH as never, lastValidBlockHeight: 1n },
            m
          ),
        (m) => setTransactionMessagePriorityFeeLamports(5_000_000_000n, m),
        (m) =>
          appendTransactionMessageInstruction(
            {
              data: new TextEncoder().encode(memo),
              programAddress: sdk.MEMO_PROGRAM_ADDRESS,
            },
            m
          ),
        (m) =>
          appendTransactionMessageInstruction(
            sdk.buildForgeInstruction(fund),
            m
          )
      ) as never
    ) as unknown as Transaction;
    const problems = await sdk.verifyPlan({
      intent: fund,
      memo,
      messageHash: await sdk.messageHash(v1),
      requiredSigners: sdk.requiredSigners(fund),
      transaction: sdk.encodeWireTransaction(v1),
    });
    expect(problems).toContain(
      "Message bytes differ from the canonical v0 compilation of the intent"
    );
  });
});
