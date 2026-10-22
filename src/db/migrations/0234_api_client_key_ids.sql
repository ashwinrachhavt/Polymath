-- 0234: split API keys into a lookup id and a secret. The key id is stored
-- in plaintext and indexed so resolution fetches one row and compares the
-- secret's SHA-256 digest in constant time (previously the digest itself was
-- the lookup, a full-column scan with no constant-time guarantee). Nullable
-- because rows minted before this format (and Clerk machine subjects, whose
-- token_hash holds the Clerk subject) have no key id; they keep resolving by
-- token_hash until re-paired.
ALTER TABLE "api_clients" ADD COLUMN IF NOT EXISTS "key_id" text;
CREATE UNIQUE INDEX IF NOT EXISTS "api_clients_key_id_key" ON "api_clients" ("key_id") WHERE "key_id" IS NOT NULL;
