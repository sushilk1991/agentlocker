PRAGMA foreign_keys = ON;
CREATE TABLE schema_version (version INTEGER PRIMARY KEY CHECK(version = 1));
INSERT INTO schema_version VALUES (1);
CREATE TABLE settings (
 id INTEGER PRIMARY KEY CHECK(id=1), setup_complete INTEGER NOT NULL DEFAULT 0 CHECK(setup_complete IN(0,1)),
 deployment_id TEXT NOT NULL, public_origin TEXT NOT NULL, config_version INTEGER NOT NULL DEFAULT 1,
 approval_ttl INTEGER NOT NULL DEFAULT 900000 CHECK(approval_ttl BETWEEN 60000 AND 3600000),
 quota_bytes INTEGER NOT NULL DEFAULT 1073741824 CHECK(quota_bytes>0), retention_ms INTEGER NOT NULL DEFAULT 604800000 CHECK(retention_ms>=604800000),
 maintenance INTEGER NOT NULL DEFAULT 0 CHECK(maintenance IN(0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE agents (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
 status TEXT NOT NULL DEFAULT 'disabled' CHECK(status IN('disabled','enabled','revoked')), version INTEGER NOT NULL DEFAULT 1,
 created_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE agent_tokens (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), token_hash TEXT NOT NULL UNIQUE,
 prefix TEXT NOT NULL, label TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
 CHECK(expires_at>created_at AND expires_at<=created_at+2592000000)
);
CREATE INDEX tokens_agent ON agent_tokens(agent_id, expires_at);
CREATE TABLE folder_grants (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), prefix TEXT NOT NULL,
 read INTEGER NOT NULL CHECK(read IN(0,1)), write INTEGER NOT NULL CHECK(write IN(0,1)), "delete" INTEGER NOT NULL CHECK("delete" IN(0,1)),
 expires_at INTEGER, version INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(agent_id,prefix)
);
CREATE TABLE secrets (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, encrypted_value TEXT NOT NULL, nonce TEXT NOT NULL,
 key_version TEXT NOT NULL, value_version INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1,
 injection_header TEXT NOT NULL, scheme TEXT NOT NULL CHECK(scheme IN('bearer','plain')),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN(0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE secret_hosts (secret_id TEXT NOT NULL REFERENCES secrets(id), hostname TEXT NOT NULL, PRIMARY KEY(secret_id,hostname));
CREATE TABLE secret_grants (
 id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id), secret_id TEXT NOT NULL REFERENCES secrets(id),
 read INTEGER NOT NULL DEFAULT 1 CHECK(read=1), expires_at INTEGER, version INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(agent_id,secret_id)
);
CREATE TABLE approval_rules (id TEXT PRIMARY KEY, operation TEXT NOT NULL CHECK(operation IN('file.read','file.write','files.list','secrets.list')), prefix TEXT, secret_id TEXT REFERENCES secrets(id), version INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE files (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, current_revision_id TEXT, deleted_at INTEGER, created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL);
CREATE INDEX files_path ON files(path);
CREATE TABLE actions (
 id TEXT PRIMARY KEY, agent_id TEXT REFERENCES agents(id), token_id TEXT REFERENCES agent_tokens(id), request_id TEXT NOT NULL,
 operation TEXT NOT NULL, target TEXT NOT NULL, digest TEXT NOT NULL, submission_digest TEXT NOT NULL,
 input_cipher TEXT, input_nonce TEXT, key_version TEXT, config_version INTEGER NOT NULL,
 target_revision TEXT, secret_id TEXT REFERENCES secrets(id), secret_version INTEGER,
 status TEXT NOT NULL CHECK(status IN('pending','ready','executing','succeeded','failed','denied','expired','invalidated','unknown')),
 approval_id TEXT, claim_id TEXT, result_cipher TEXT, result_nonce TEXT, result_key_version TEXT,
 result_revision TEXT, result_metadata TEXT, error_code TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, result_expires_at INTEGER
);
CREATE INDEX actions_agent ON actions(agent_id,created_at);
CREATE INDEX actions_state ON actions(status,updated_at);
CREATE TABLE file_revisions (
 id TEXT PRIMARY KEY, file_id TEXT NOT NULL REFERENCES files(id), object_key TEXT NOT NULL,
 hash TEXT NOT NULL, length INTEGER NOT NULL CHECK(length>=0), media_type TEXT NOT NULL,
 author_kind TEXT NOT NULL, agent_id TEXT REFERENCES agents(id), token_id TEXT REFERENCES agent_tokens(id),
 action_id TEXT, uploaded INTEGER NOT NULL DEFAULT 0 CHECK(uploaded IN(0,1)), created_at INTEGER NOT NULL, retain_until INTEGER
);
CREATE INDEX revisions_file ON file_revisions(file_id,created_at);
CREATE INDEX revisions_retention ON file_revisions(retain_until);
CREATE TABLE approvals (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE REFERENCES actions(id),
 state TEXT NOT NULL CHECK(state IN('pending','approved','denied','expired','invalidated')),
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, decision_request_id TEXT, reason TEXT, batch_id TEXT
);
CREATE INDEX approvals_state ON approvals(state,expires_at);
CREATE TABLE execution_attempts (
 id TEXT PRIMARY KEY, action_id TEXT NOT NULL UNIQUE REFERENCES actions(id), attempt_number INTEGER NOT NULL DEFAULT 1,
 claimed_at INTEGER NOT NULL, dispatch_started_at INTEGER, completed_at INTEGER, state TEXT NOT NULL CHECK(state IN('claimed','dispatched','succeeded','failed','unknown')),
 upstream_status INTEGER, error_code TEXT
);
CREATE TABLE idempotency_keys (
 identity TEXT NOT NULL, caller_key TEXT NOT NULL, input_digest TEXT NOT NULL, action_id TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(identity,caller_key)
);
CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);
CREATE TABLE audit_events (
 id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL DEFAULT(CAST(unixepoch('subsec')*1000 AS INTEGER)),
 request_id TEXT NOT NULL, action_id TEXT, approval_id TEXT, attempt_id TEXT, batch_id TEXT,
 actor_kind TEXT NOT NULL, agent_id TEXT, token_id TEXT, actor_name TEXT NOT NULL,
 operation TEXT NOT NULL, target TEXT NOT NULL, decision TEXT NOT NULL, result TEXT NOT NULL,
 http_status INTEGER, reason_code TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_agent ON audit_events(agent_id,id);
CREATE INDEX audit_target ON audit_events(target,id);
CREATE INDEX audit_action ON audit_events(action_id,id);
CREATE INDEX audit_time ON audit_events(timestamp,id);
CREATE TABLE rate_windows (identity TEXT NOT NULL, class TEXT NOT NULL, bucket INTEGER NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(identity,class,bucket));
CREATE TRIGGER quota_reserve BEFORE INSERT ON file_revisions
 WHEN (SELECT COALESCE(SUM(length),0) FROM file_revisions)+NEW.length>(SELECT quota_bytes FROM settings WHERE id=1)
 BEGIN SELECT RAISE(ABORT,'quota_exceeded'); END;
CREATE TRIGGER pending_cap BEFORE INSERT ON actions WHEN NEW.status IN('pending','ready') AND NEW.agent_id IS NOT NULL
 BEGIN
 SELECT CASE WHEN (SELECT COUNT(*) FROM actions WHERE status IN('pending','ready'))>=100 OR (SELECT COUNT(*) FROM actions WHERE agent_id=NEW.agent_id AND status IN('pending','ready'))>=20 THEN RAISE(ABORT,'pending_limit') END;
 END;
CREATE TRIGGER action_immutable BEFORE UPDATE OF agent_id,token_id,operation,target,digest,submission_digest,target_revision,secret_id,secret_version,config_version,expires_at ON actions
 BEGIN SELECT RAISE(ABORT,'immutable_action'); END;
CREATE TRIGGER approval_final BEFORE UPDATE ON approvals WHEN OLD.state!='pending'
 BEGIN SELECT RAISE(ABORT,'immutable_decision'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'append_only'); END;
