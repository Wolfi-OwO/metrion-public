-- TimescaleDB: hypertables, compression, continuous aggregates, retention
-- policies. See docs/adr/0004-postgres-timescaledb-over-append-blob.md for
-- why this runs self-hosted rather than on managed Azure Postgres (the
-- Apache-2 build there has none of the three features this schema needs).
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- citext: case-insensitive email comparisons (users.email, identities.email)
-- without a lower() call at every call site.
CREATE EXTENSION IF NOT EXISTS citext;
