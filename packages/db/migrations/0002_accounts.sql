-- Accounts: a user authenticates via one or more OAuth identities, owns
-- projects, and issues API keys scoped to a project. Tenancy for every
-- metrics write is resolved from the API key, never from request content -
-- see docs/adr/0005-api-key-determines-tenancy.md.

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email citext NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Keyed on (provider, provider_subject) - the immutable subject an OAuth
-- provider issues - never on email, which a provider can let a user change.
CREATE TABLE identities (
  user_id uuid NOT NULL REFERENCES users (id),
  provider text NOT NULL,
  provider_subject text NOT NULL,
  email citext,
  UNIQUE (provider, provider_subject)
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  default_resource text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- key_hash, never the raw key, is stored - key_prefix is what a UI shows
-- ("mk_live_ab12...") to let a user tell keys apart without re-revealing one.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id),
  key_prefix text NOT NULL UNIQUE,
  key_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id),
  expires_at timestamptz NOT NULL
);
