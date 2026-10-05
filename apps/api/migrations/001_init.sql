-- FORGE API and reconciler schema.
-- PostgreSQL is the source of truth for intents, attempts and postings; the chain is the
-- source of truth for balances and loan state (vault/loan/withdrawal rows are projections).
-- u64 amounts are numeric(20,0): bigint is signed 64-bit and cannot hold every u64.

CREATE TABLE institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,
  webhook_url text,
  webhook_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vaults (
  address text PRIMARY KEY,
  institution_id uuid NOT NULL REFERENCES institutions (id),
  vault_ref text NOT NULL,
  vault_id text NOT NULL,
  treasury text NOT NULL,
  mint text NOT NULL,
  token_account text NOT NULL UNIQUE,
  treasury_destination text NOT NULL,
  approvers jsonb NOT NULL,
  per_loan_limit numeric(20, 0) NOT NULL,
  outstanding_limit numeric(20, 0) NOT NULL,
  -- Projection, filled from finalized chain state.
  onchain boolean NOT NULL DEFAULT false,
  outstanding_principal numeric(20, 0),
  disbursement_paused boolean,
  pause_seq numeric(20, 0),
  cash numeric(20, 0),
  synced_slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, vault_ref)
);

CREATE TABLE loans (
  address text PRIMARY KEY,
  vault text NOT NULL REFERENCES vaults (address),
  loan_ref text NOT NULL,
  loan_id text NOT NULL,
  borrower text NOT NULL,
  destination text NOT NULL,
  principal numeric(20, 0) NOT NULL,
  term_rate_bps integer NOT NULL,
  term_seconds bigint NOT NULL,
  offer_expiry bigint NOT NULL,
  onchain boolean NOT NULL DEFAULT false,
  fixed_interest numeric(20, 0),
  fixed_payoff numeric(20, 0),
  approvals jsonb,
  state text,
  proposed_at bigint,
  disbursed_at bigint,
  repaid_at bigint,
  synced_slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault, loan_ref)
);

CREATE TABLE withdrawals (
  address text PRIMARY KEY,
  vault text NOT NULL REFERENCES vaults (address),
  withdrawal_ref text NOT NULL,
  withdrawal_id text NOT NULL,
  amount numeric(20, 0) NOT NULL,
  onchain boolean NOT NULL DEFAULT false,
  approvals jsonb,
  state text,
  proposed_at bigint,
  executed_at bigint,
  synced_slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vault, withdrawal_ref)
);

-- One row per business action. origin = 'api' (planned here) or 'chain' (observed by the
-- indexer without a matching plan, e.g. a direct program call).
CREATE TABLE operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES institutions (id),
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  origin text NOT NULL DEFAULT 'api' CHECK (origin IN ('api', 'chain')),
  kind text NOT NULL,
  vault text NOT NULL,
  subject text NOT NULL,
  intent jsonb NOT NULL,
  display jsonb NOT NULL DEFAULT '{}',
  required_signers jsonb NOT NULL,
  status text NOT NULL CHECK (status IN (
    'prepared', 'submitted', 'confirmed', 'finalized',
    'failed', 'expired', 'already_applied', 'needs_review'
  )),
  status_reason text,
  error jsonb,
  applied_signature text,
  finalized_slot bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (institution_id, idempotency_key)
);

CREATE INDEX operations_vault_idx ON operations (vault, created_at DESC);
CREATE INDEX operations_open_idx ON operations (vault, kind)
  WHERE status IN ('prepared', 'submitted', 'confirmed', 'expired');

-- One row per signed (or to-be-signed) transaction. The unsigned wire transaction pins the
-- message (and therefore the transaction id) before anyone signs it.
CREATE TABLE tx_attempts (
  id bigserial PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES operations (id),
  attempt_no integer NOT NULL,
  unsigned_tx bytea NOT NULL,
  message_hash text NOT NULL,
  signatures jsonb NOT NULL DEFAULT '{}',
  signed_tx bytea,
  signature text UNIQUE,
  blockhash text NOT NULL,
  last_valid_block_height bigint NOT NULL,
  status text NOT NULL CHECK (status IN (
    'awaiting_signatures', 'live', 'landed_ok', 'landed_err', 'expired'
  )),
  confirmation text CHECK (confirmation IN ('processed', 'confirmed', 'finalized')),
  err jsonb,
  slot bigint,
  send_count integer NOT NULL DEFAULT 0,
  last_sent_at timestamptz,
  last_send_error text,
  next_check_at timestamptz NOT NULL DEFAULT now(),
  lease_owner text,
  lease_until timestamptz,
  lease_epoch bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, attempt_no),
  CHECK (status <> 'awaiting_signatures' OR signed_tx IS NULL),
  -- A live attempt is always broadcastable. Landed attempts may lack signed bytes when the
  -- signer's wallet broadcast them and the indexer matched them by message hash.
  CHECK (status <> 'live' OR (signed_tx IS NOT NULL AND signature IS NOT NULL))
);

-- The core safety invariant: at most one attempt per operation that could still land.
CREATE UNIQUE INDEX tx_attempts_one_live ON tx_attempts (operation_id)
  WHERE status IN ('awaiting_signatures', 'live');
CREATE INDEX tx_attempts_message_hash_idx ON tx_attempts (message_hash);
CREATE INDEX tx_attempts_tracking_idx ON tx_attempts (next_check_at)
  WHERE status IN ('live', 'landed_ok', 'landed_err')
    AND confirmation IS DISTINCT FROM 'finalized';

-- Every finalized transaction the reconciler has processed, success or failure.
CREATE TABLE chain_transactions (
  network text NOT NULL,
  signature text NOT NULL,
  slot bigint NOT NULL,
  block_time bigint,
  err jsonb,
  fee_payer text NOT NULL,
  message_hash text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (network, signature)
);

-- One row per successful Forge instruction (top-level or CPI).
CREATE TABLE chain_events (
  id bigserial PRIMARY KEY,
  network text NOT NULL,
  signature text NOT NULL,
  ix_index integer NOT NULL,
  inner_index integer NOT NULL DEFAULT -1,
  kind text NOT NULL,
  vault text NOT NULL,
  subject text NOT NULL,
  operation_id uuid REFERENCES operations (id),
  intent jsonb NOT NULL,
  slot bigint NOT NULL,
  block_time bigint,
  UNIQUE (network, signature, ix_index, inner_index)
);

CREATE TABLE exceptions (
  id bigserial PRIMARY KEY,
  network text NOT NULL,
  vault text NOT NULL,
  kind text NOT NULL,
  signature text NOT NULL,
  amount numeric(20, 0),
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (network, kind, signature)
);

-- Balanced double-entry lines; each event or exception posts once.
CREATE TABLE postings (
  id bigserial PRIMARY KEY,
  event_id bigint REFERENCES chain_events (id),
  exception_id bigint REFERENCES exceptions (id),
  vault text NOT NULL,
  entry text NOT NULL,
  account text NOT NULL,
  debit numeric(20, 0) NOT NULL DEFAULT 0,
  credit numeric(20, 0) NOT NULL DEFAULT 0,
  signature text NOT NULL,
  slot bigint NOT NULL,
  business_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((event_id IS NULL) <> (exception_id IS NULL)),
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0))
);

CREATE INDEX postings_vault_idx ON postings (vault, slot, id);

CREATE TABLE webhook_outbox (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  institution_id uuid NOT NULL REFERENCES institutions (id),
  type text NOT NULL,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX webhook_outbox_pending_idx ON webhook_outbox (next_attempt_at)
  WHERE delivered_at IS NULL;

-- Newest finalized signature processed per watched address.
CREATE TABLE cursors (
  name text PRIMARY KEY,
  signature text,
  slot bigint,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE worker_heartbeats (
  worker_id text PRIMARY KEY,
  seen_at timestamptz NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'
);
