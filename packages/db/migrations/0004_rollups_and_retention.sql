-- Compression, the hourly rollup, and retention - all three properties of
-- the storage platform, not application code anyone has to babysit. See
-- docs/adr/0004-postgres-timescaledb-over-append-blob.md, item 5: this is
-- ADR 0001's "retention enforced by the platform" principle re-adopted, not
-- reversed.

ALTER TABLE metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'project_id, resource, name',
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('metrics', INTERVAL '7 days');

-- Replaces the "pre-aggregated hourly rollup blob" upgrade path named in
-- applications/viewer/src/services/metrics-service.ts:10-18 - a
-- materialized, incrementally-refreshed rollup in the same store as the raw
-- rows, not a second file format to merge with the first.
CREATE MATERIALIZED VIEW metrics_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', time) AS bucket,
  project_id,
  resource,
  sub_resource,
  name,
  avg(value) AS avg_value,
  min(value) AS min_value,
  max(value) AS max_value,
  count(*) AS sample_count
FROM metrics
GROUP BY bucket, project_id, resource, sub_resource, name
WITH NO DATA;

SELECT add_continuous_aggregate_policy('metrics_hourly',
  start_offset => INTERVAL '3 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour');

-- Chunks older than 90 days are dropped by the platform - the same "zero
-- application code" property ADR 0001's Blob Lifecycle Management policy
-- provided, now provided by TimescaleDB instead.
SELECT add_retention_policy('metrics', INTERVAL '90 days');
