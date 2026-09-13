-- The metrics hypertable. project_id is a real column in a real index here
-- (not an in-memory filter over parsed blob lines) - see
-- docs/adr/0004-postgres-timescaledb-over-append-blob.md for why that's the
-- property this migration exists to provide.
CREATE TABLE metrics (
  time timestamptz NOT NULL,
  project_id uuid NOT NULL,
  resource text NOT NULL,
  sub_resource text,
  name text NOT NULL,
  value double precision NOT NULL,
  unit text NOT NULL,
  interval_seconds integer NOT NULL
);

SELECT create_hypertable('metrics', 'time', chunk_time_interval => INTERVAL '7 days');

-- Series read: "this project's resource/sub_resource/name, over time" - the
-- shape every chart query takes.
CREATE INDEX metrics_series_idx ON metrics (project_id, resource, sub_resource, name, time DESC);

-- Resource-discovery scan: "what does this project have, recently" - the
-- shape a picker/summary query takes, without naming a metric first.
CREATE INDEX metrics_project_time_idx ON metrics (project_id, time DESC);

-- No index on `unit` - it is never a filter or sort key, only a label
-- carried alongside a value (see docs/adr/0003-generic-metric-envelope.md).
