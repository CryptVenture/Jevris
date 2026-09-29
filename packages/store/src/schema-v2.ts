/**
 * DDL for store schema versions 2 to 5 (SSOT §17.1 durable data model). Each constant is
 * one migration; its text is checksummed into `schema_migrations`, so an applied migration
 * is never edited: add a new one instead.
 */

/** v2: workspace, session, event, capsule index, outbox retry state (DATA-02). */
export const DURABLE_MODEL_SQL = `
CREATE TABLE IF NOT EXISTS maintenance_flag (
  name TEXT PRIMARY KEY CHECK (name IN ('retention', 'delete'))
);

CREATE TABLE IF NOT EXISTS workspace (
  workspace_id TEXT PRIMARY KEY,
  root_identity TEXT NOT NULL UNIQUE,
  root_path TEXT NOT NULL,
  trust TEXT NOT NULL DEFAULT 'untrusted' CHECK (trust IN ('untrusted', 'trusted', 'restricted')),
  egress_policy TEXT NOT NULL DEFAULT 'deny' CHECK (egress_policy IN ('deny', 'allowlist', 'allow')),
  config_revision TEXT NOT NULL DEFAULT '',
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  workspace_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  harness TEXT NOT NULL,
  harness_version TEXT,
  requested_model TEXT,
  actual_model TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'ended', 'unknown')),
  started_at_ms INTEGER NOT NULL,
  ended_at_ms INTEGER,
  PRIMARY KEY (workspace_id, session_id)
);

CREATE TABLE IF NOT EXISTS event (
  workspace_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  delivery_key TEXT NOT NULL,
  session_id TEXT,
  native_kind TEXT NOT NULL,
  revision TEXT,
  payload_hash TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0 AND payload_bytes <= 65536),
  received_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, seq),
  UNIQUE (workspace_id, delivery_key)
);

CREATE TRIGGER IF NOT EXISTS event_no_update BEFORE UPDATE ON event
BEGIN
  SELECT RAISE(ABORT, 'event is append-only');
END;

CREATE TRIGGER IF NOT EXISTS event_no_delete BEFORE DELETE ON event
WHEN NOT EXISTS (SELECT 1 FROM maintenance_flag)
BEGIN
  SELECT RAISE(ABORT, 'event is append-only');
END;

CREATE TABLE IF NOT EXISTS capsule_index (
  workspace_id TEXT NOT NULL,
  capsule_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  task_id TEXT,
  encoder_version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  retention_class TEXT NOT NULL DEFAULT 'standard' CHECK (retention_class IN ('standard', 'pinned')),
  validity TEXT NOT NULL DEFAULT 'current' CHECK (validity IN ('current', 'invalidated', 'superseded')),
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, capsule_id, version)
);

ALTER TABLE outbox_entry ADD COLUMN idempotency_key TEXT;
ALTER TABLE outbox_entry ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbox_entry ADD COLUMN max_retries INTEGER NOT NULL DEFAULT 5;
ALTER TABLE outbox_entry ADD COLUMN next_attempt_at_ms INTEGER;
ALTER TABLE outbox_entry ADD COLUMN last_error_code TEXT;
ALTER TABLE outbox_entry ADD COLUMN created_at_ms INTEGER;
`;

/** v3: tasks, dependency edges, transition history, human exceptions (DATA-03). */
export const TASK_MODEL_SQL = `
CREATE TABLE IF NOT EXISTS task (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL CHECK (state IN (
    'proposed', 'validated', 'ready', 'leased', 'running', 'awaiting-evidence',
    'verifying', 'verified', 'failed', 'blocked', 'cancelled'
  )),
  owner_id TEXT NOT NULL,
  root_budget_id TEXT NOT NULL,
  requirement_ids TEXT NOT NULL DEFAULT '[]',
  state_reason TEXT,
  verified_by TEXT CHECK (verified_by IS NULL OR verified_by IN ('checks', 'exception')),
  record TEXT NOT NULL DEFAULT '{}',
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, task_id),
  CHECK ((state = 'verified') = (verified_by IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS task_edge (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (workspace_id, task_id, depends_on),
  CHECK (task_id <> depends_on),
  FOREIGN KEY (workspace_id, task_id) REFERENCES task (workspace_id, task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_transition (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL CHECK (actor IN ('planner', 'scheduler', 'agent', 'runner', 'human', 'reconciler')),
  reason_code TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, task_id, seq),
  FOREIGN KEY (workspace_id, task_id) REFERENCES task (workspace_id, task_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_exception (
  workspace_id TEXT NOT NULL,
  exception_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  reason TEXT NOT NULL,
  authorization_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, exception_id),
  FOREIGN KEY (workspace_id, task_id) REFERENCES task (workspace_id, task_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS task_by_state ON task (workspace_id, state);
`;

/** v4: immutable decision records and verification receipts (DATA-05, VER). */
export const LEDGER_MODEL_SQL = `
CREATE TABLE IF NOT EXISTS decision_record (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  task_id TEXT,
  kind TEXT NOT NULL,
  spec_version TEXT NOT NULL,
  model TEXT NOT NULL,
  encoder_version TEXT NOT NULL,
  calibration_version TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  state TEXT NOT NULL,
  outcome TEXT NOT NULL,
  reason_codes TEXT NOT NULL,
  latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
  provider_calls INTEGER NOT NULL DEFAULT 0,
  usage_known INTEGER NOT NULL CHECK (usage_known IN (0, 1)),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0,
  cost_micro_usd INTEGER,
  billing_basis TEXT NOT NULL,
  process_role TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('journal', 'legacy-ledger', 'direct')),
  record TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, decision_id)
);

CREATE INDEX IF NOT EXISTS decision_record_by_time ON decision_record (created_at_ms);

CREATE TRIGGER IF NOT EXISTS decision_record_immutable BEFORE UPDATE OF
  workspace_id, decision_id, task_id, kind, spec_version, model, encoder_version,
  calibration_version, policy_version, state, outcome, reason_codes, latency_ms,
  provider_calls, reserved_micro_usd, process_role, source, record, created_at_ms
ON decision_record
BEGIN
  SELECT RAISE(ABORT, 'decision records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS decision_record_usage_once BEFORE UPDATE OF
  usage_known, input_tokens, output_tokens, cost_micro_usd, billing_basis
ON decision_record
WHEN OLD.usage_known = 1 AND OLD.cost_micro_usd IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'reconciled usage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS decision_record_no_delete BEFORE DELETE ON decision_record
WHEN NOT EXISTS (SELECT 1 FROM maintenance_flag)
BEGIN
  SELECT RAISE(ABORT, 'decision records are immutable');
END;

CREATE TABLE IF NOT EXISTS verification_receipt (
  workspace_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  task_id TEXT,
  check_id TEXT NOT NULL,
  issuer TEXT NOT NULL CHECK (issuer IN ('local-runner', 'ci-import')),
  input_revision TEXT NOT NULL,
  scope_revision TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  environment_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('passed', 'failed', 'unknown', 'not-run')),
  raw_hash TEXT,
  body TEXT NOT NULL,
  validity TEXT NOT NULL DEFAULT 'current' CHECK (validity IN ('current', 'invalidated')),
  recorded_at_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, receipt_id)
);

CREATE INDEX IF NOT EXISTS verification_receipt_by_task ON verification_receipt (workspace_id, task_id);

CREATE TRIGGER IF NOT EXISTS verification_receipt_no_edit BEFORE UPDATE OF
  workspace_id, receipt_id, task_id, check_id, issuer, input_revision, scope_revision,
  runner_id, environment_hash, outcome, raw_hash, body, recorded_at_ms
ON verification_receipt
BEGIN
  SELECT RAISE(ABORT, 'a receipt can be invalidated, never edited');
END;

CREATE TRIGGER IF NOT EXISTS verification_receipt_no_revalidate BEFORE UPDATE OF validity ON verification_receipt
WHEN OLD.validity = 'invalidated' AND NEW.validity <> 'invalidated'
BEGIN
  SELECT RAISE(ABORT, 'an invalidated receipt stays invalidated');
END;
`;

/** v5: hash-chained audit log and authorization receipts (GOV-09, GOV-10). */
export const GOVERNANCE_MODEL_SQL = `
CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  channel TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE
);

CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'the audit log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'the audit log is append-only');
END;

CREATE TABLE IF NOT EXISTS authorization_receipt (
  authorization_id TEXT PRIMARY KEY,
  principal TEXT NOT NULL,
  action_class TEXT NOT NULL,
  scope TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel = 'terminal'),
  issued_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > issued_at_ms),
  consumed_at_ms INTEGER,
  mac TEXT NOT NULL
);
`;
