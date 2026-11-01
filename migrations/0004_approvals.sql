CREATE TRIGGER action_input_immutable BEFORE UPDATE OF input_cipher,input_nonce,key_version ON actions
 WHEN OLD.operation NOT IN ('file.write','file.delete','file.restore','file.read','files.list')
 AND (NEW.input_cipher IS NOT NULL OR NEW.input_nonce IS NOT NULL OR NEW.key_version IS NOT NULL)
 BEGIN SELECT RAISE(ABORT,'immutable_action'); END;
CREATE TRIGGER action_state_transition BEFORE UPDATE OF status ON actions
 WHEN NEW.status != OLD.status AND NOT (
  (OLD.status='pending' AND NEW.status IN('ready','denied','expired','invalidated','failed')) OR
  (OLD.status='ready' AND NEW.status IN('executing','expired','invalidated','succeeded','failed')) OR
  (OLD.status='executing' AND NEW.status IN('succeeded','failed','unknown')))
 BEGIN SELECT RAISE(ABORT,'invalid_action_transition'); END;
CREATE TRIGGER action_deadline BEFORE UPDATE OF status ON actions
 WHEN ((OLD.status='pending' AND NEW.status='ready') OR (OLD.status='ready' AND NEW.status IN('executing','succeeded')))
 AND OLD.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
 BEGIN SELECT RAISE(ABORT,'action_expired'); END;
CREATE TRIGGER approval_deadline BEFORE UPDATE OF state ON approvals
 WHEN NEW.state IN('approved','denied') AND OLD.expires_at<=CAST(unixepoch('subsec')*1000 AS INTEGER)
 BEGIN SELECT RAISE(ABORT,'action_expired'); END;
UPDATE schema_version SET version=4;
