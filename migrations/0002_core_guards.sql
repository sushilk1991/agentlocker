-- Wrangler tracks applied migration files. Run this after 0001_initial.sql.
DROP TABLE schema_version;
CREATE TABLE schema_version (version INTEGER PRIMARY KEY CHECK(version > 0));
INSERT INTO schema_version VALUES (2);

-- A stale policy replacement aborts its entire D1 batch, including its audit event.
CREATE TRIGGER agent_version_step BEFORE UPDATE OF version ON agents
 WHEN NEW.version != OLD.version + 1
 BEGIN SELECT RAISE(ABORT, 'version_conflict'); END;

CREATE TRIGGER agent_revoked_final BEFORE UPDATE OF status ON agents
 WHEN OLD.status = 'revoked' AND NEW.status != 'revoked'
 BEGIN SELECT RAISE(ABORT, 'agent_revoked'); END;

CREATE TRIGGER token_hash_format BEFORE INSERT ON agent_tokens
 WHEN length(NEW.token_hash) != 64 OR NEW.token_hash GLOB '*[^0-9a-f]*'
 BEGIN SELECT RAISE(ABORT, 'invalid_token_hash'); END;

CREATE TRIGGER token_immutable BEFORE UPDATE OF id, agent_id, token_hash, prefix, label, created_at, expires_at ON agent_tokens
 BEGIN SELECT RAISE(ABORT, 'immutable_token'); END;

CREATE TRIGGER token_revoked_final BEFORE UPDATE OF revoked_at ON agent_tokens
 WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
 BEGIN SELECT RAISE(ABORT, 'credential_revoked'); END;

CREATE INDEX audit_decision ON audit_events(decision, id);
CREATE INDEX audit_request ON audit_events(request_id, id);
CREATE INDEX audit_token ON audit_events(token_id, id);
