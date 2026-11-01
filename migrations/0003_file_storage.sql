-- A conditional mutation must affect exactly one row. This scratch assertion is
-- inserted and removed inside the same D1 batch. CHECK failure rolls it all back.
CREATE TABLE file_commit_guard (ok INTEGER NOT NULL CONSTRAINT file_commit_conflict CHECK(ok=1));
ALTER TABLE file_revisions ADD COLUMN published_at INTEGER;
UPDATE file_revisions SET published_at=created_at WHERE uploaded=1 AND (id IN (SELECT current_revision_id FROM files) OR action_id IS NULL
 OR EXISTS(SELECT 1 FROM actions a WHERE a.id=file_revisions.action_id AND a.status='succeeded' AND a.result_revision=file_revisions.id));
CREATE INDEX revisions_object ON file_revisions(object_key);
CREATE INDEX revisions_action ON file_revisions(action_id);
CREATE INDEX actions_result_revision ON actions(result_revision);
CREATE TRIGGER revision_content_immutable
 BEFORE UPDATE OF id,file_id,object_key,hash,length,media_type,author_kind,agent_id,token_id,action_id,created_at ON file_revisions
 BEGIN SELECT RAISE(ABORT,'immutable_revision'); END;
CREATE TRIGGER file_action_input_immutable BEFORE UPDATE OF input_cipher,input_nonce,key_version ON actions
 WHEN OLD.operation IN ('file.write','file.delete','file.restore','file.read','files.list')
  AND (NEW.input_cipher IS NOT NULL OR NEW.input_nonce IS NOT NULL OR NEW.key_version IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'immutable_action'); END;
UPDATE schema_version SET version=3;
