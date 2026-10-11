-- Spec 0016: the API key saved in Settings becomes an `api_key` Claude account and the default.
-- Idempotent: only when a key is set and no default account was chosen yet.
WITH moved AS (
  INSERT INTO "claude_accounts" ("label", "kind", "api_key")
  SELECT 'API key', 'api_key', "anthropic_api_key"
  FROM "settings"
  WHERE "id" = 'default' AND "anthropic_api_key" IS NOT NULL AND "default_claude_account_id" IS NULL
  RETURNING "id"
)
UPDATE "settings" SET "default_claude_account_id" = (SELECT "id" FROM moved)
WHERE "id" = 'default' AND EXISTS (SELECT 1 FROM moved);
