-- One transaction can leave unexplained movements on several vaults (possibly of different
-- institutions); each vault's residual is its own exception, so the vault is part of the key.
ALTER TABLE exceptions DROP CONSTRAINT exceptions_network_kind_signature_key;
ALTER TABLE exceptions ADD CONSTRAINT exceptions_network_vault_kind_signature_key
  UNIQUE (network, vault, kind, signature);
