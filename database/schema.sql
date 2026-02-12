-- =============================================================================
-- HIGH-SCALE ENERGY INGESTION ENGINE — POSTGRESQL SCHEMA
-- =============================================================================
-- Target: 28M+ records/day from 10K smart meters + 10K EV vehicles
-- Strategy: Hot/Cold separation, insert-only history, upsert live state
-- =============================================================================

-- Enable required extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. COLD STORE — VEHICLE TELEMETRY HISTORY (Insert-Only, Partitioned)
-- =============================================================================
-- This is the append-only time-series table for all EV vehicle readings.
-- Partitioned by MONTH on recorded_at for:
--   - Partition pruning on time-range queries (touch only relevant months)
--   - Instant partition drops for retention (no DELETE on millions of rows)
--   - Independent VACUUM/ANALYZE per partition
--   - Parallel sequential scans across partitions for analytics

CREATE TABLE vehicle_telemetry_history (
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    vehicle_id      VARCHAR(64)      NOT NULL,
    soc             NUMERIC(5, 2)    NOT NULL,  -- State of charge: 0.00–100.00%
    kwh_delivered_dc NUMERIC(10, 4)  NOT NULL,  -- DC energy delivered in kWh
    battery_temp    NUMERIC(5, 2)    NOT NULL,  -- Battery temperature in °C
    recorded_at     TIMESTAMPTZ      NOT NULL,  -- Device-reported timestamp
    ingested_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(), -- Server receive time
    CONSTRAINT vehicle_telemetry_history_pkey PRIMARY KEY (recorded_at, id)
) PARTITION BY RANGE (recorded_at);

-- WHY no UNIQUE on (vehicle_id, recorded_at)?
-- At 28M inserts/day, enforcing uniqueness on a growing table adds B-tree
-- maintenance overhead on every insert. Duplicate handling is done at the
-- application layer (idempotency keys in the ingestion buffer). The primary
-- key on (recorded_at, id) is partition-local and cheap.

-- =============================================================================
-- 2. COLD STORE — METER TELEMETRY HISTORY (Insert-Only, Partitioned)
-- =============================================================================

CREATE TABLE meter_telemetry_history (
    id              BIGINT GENERATED ALWAYS AS IDENTITY,
    meter_id        VARCHAR(64)      NOT NULL,
    kwh_consumed_ac NUMERIC(10, 4)   NOT NULL,  -- AC energy consumed in kWh
    voltage         NUMERIC(6, 2)    NOT NULL,  -- Voltage in V
    recorded_at     TIMESTAMPTZ      NOT NULL,
    ingested_at     TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    CONSTRAINT meter_telemetry_history_pkey PRIMARY KEY (recorded_at, id)
) PARTITION BY RANGE (recorded_at);

-- =============================================================================
-- 3. HOT STORE — VEHICLE CURRENT STATUS (Upsert Target)
-- =============================================================================
-- One row per vehicle. Always holds the LATEST reading.
-- Tiny table (~10K rows) — fits entirely in shared_buffers.
-- Serves sub-millisecond "what is vehicle X doing right now?" queries.

CREATE TABLE vehicle_current_status (
    vehicle_id      VARCHAR(64)      PRIMARY KEY,
    soc             NUMERIC(5, 2)    NOT NULL,
    kwh_delivered_dc NUMERIC(10, 4)  NOT NULL,
    battery_temp    NUMERIC(5, 2)    NOT NULL,
    last_seen_at    TIMESTAMPTZ      NOT NULL,  -- Most recent recorded_at
    updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 4. HOT STORE — METER CURRENT STATUS (Upsert Target)
-- =============================================================================

CREATE TABLE meter_current_status (
    meter_id        VARCHAR(64)      PRIMARY KEY,
    kwh_consumed_ac NUMERIC(10, 4)   NOT NULL,
    voltage         NUMERIC(6, 2)    NOT NULL,
    last_seen_at    TIMESTAMPTZ      NOT NULL,
    updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

-- =============================================================================
-- 5. VEHICLE-METER LINK (Charging Station Association)
-- =============================================================================
-- Maps each vehicle to the meter at its charging station.
-- Required for efficiency calculations: DC delivered / AC consumed.
-- Tiny table (~10K rows) — PK lookup is sub-millisecond.

CREATE TABLE vehicle_meter_link (
    vehicle_id      VARCHAR(64)      PRIMARY KEY REFERENCES vehicle_current_status(vehicle_id),
    meter_id        VARCHAR(64)      NOT NULL REFERENCES meter_current_status(meter_id),
    linked_at       TIMESTAMPTZ      NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_vehicle_meter_link_meter
    ON vehicle_meter_link (meter_id);

-- =============================================================================
-- 6. ROLLUP TABLES — PRE-AGGREGATED ANALYTICS
-- =============================================================================
-- Dashboard and reporting queries NEVER touch the raw history tables.
-- A scheduled job aggregates into these tables every 15 minutes.

CREATE TABLE vehicle_hourly_stats (
    vehicle_id      VARCHAR(64)      NOT NULL,
    hour_bucket     TIMESTAMPTZ      NOT NULL,  -- Truncated to hour
    reading_count   INTEGER          NOT NULL DEFAULT 0,
    avg_soc         NUMERIC(5, 2),
    min_soc         NUMERIC(5, 2),
    max_soc         NUMERIC(5, 2),
    total_kwh_dc    NUMERIC(12, 4),
    avg_battery_temp NUMERIC(5, 2),
    max_battery_temp NUMERIC(5, 2),
    CONSTRAINT vehicle_hourly_stats_pkey PRIMARY KEY (vehicle_id, hour_bucket)
);

CREATE TABLE meter_hourly_stats (
    meter_id        VARCHAR(64)      NOT NULL,
    hour_bucket     TIMESTAMPTZ      NOT NULL,
    reading_count   INTEGER          NOT NULL DEFAULT 0,
    total_kwh_ac    NUMERIC(12, 4),
    avg_voltage     NUMERIC(6, 2),
    min_voltage     NUMERIC(6, 2),
    max_voltage     NUMERIC(6, 2),
    CONSTRAINT meter_hourly_stats_pkey PRIMARY KEY (meter_id, hour_bucket)
);

-- =============================================================================
-- 6. INDEXES — COLD STORE
-- =============================================================================

-- ---------- COMPOSITE B-TREE INDEXES ----------
-- These serve the primary query pattern on the cold store:
-- "Get readings for device X within time range Y"
--
-- DESC on recorded_at because analytics queries almost always want
-- the most recent data first (ORDER BY recorded_at DESC LIMIT N).
-- Postgres can do a backward index scan, but DESC avoids the overhead.
--
-- These are defined on the parent table and automatically propagate
-- to all child partitions.

CREATE INDEX idx_vehicle_history_device_time
    ON vehicle_telemetry_history (vehicle_id, recorded_at DESC);

CREATE INDEX idx_meter_history_device_time
    ON meter_telemetry_history (meter_id, recorded_at DESC);

-- ---------- BRIN INDEXES ----------
-- BRIN (Block Range INdex) is ideal here because:
--
-- 1. Data arrives roughly in time order (telemetry is near-real-time).
--    BRIN exploits physical correlation between row position and column value.
--    It stores min/max of recorded_at per block range (128 pages default).
--
-- 2. At 28M rows/day, a B-tree index on recorded_at alone would be ~2GB/month.
--    A BRIN index on the same column is ~100KB. Three orders of magnitude smaller.
--
-- 3. For broad time-range scans ("all readings in the last 24 hours"),
--    BRIN skips irrelevant blocks at near-zero cost. Combined with partition
--    pruning, a "last 24 hours" query touches 1-2 partitions and BRIN
--    narrows within those partitions.
--
-- 4. BRIN has near-zero write overhead. B-tree slows inserts as it grows.
--    BRIN stays tiny and fast regardless of table size.
--
-- WHEN NOT TO USE BRIN: If data arrives severely out of order (e.g., backfill
-- of historical data), physical correlation breaks and BRIN becomes useless.
-- For backfills, use a separate staging table and COPY into the correct partition.

CREATE INDEX idx_vehicle_history_brin_time
    ON vehicle_telemetry_history USING BRIN (recorded_at)
    WITH (pages_per_range = 64);

CREATE INDEX idx_meter_history_brin_time
    ON meter_telemetry_history USING BRIN (recorded_at)
    WITH (pages_per_range = 64);

-- ---------- INGESTION TIMESTAMP INDEX ----------
-- For monitoring pipeline lag: "how far behind is ingestion?"
-- BRIN is perfect here too — ingested_at is strictly monotonic.

CREATE INDEX idx_vehicle_history_brin_ingested
    ON vehicle_telemetry_history USING BRIN (ingested_at)
    WITH (pages_per_range = 64);

CREATE INDEX idx_meter_history_brin_ingested
    ON meter_telemetry_history USING BRIN (ingested_at)
    WITH (pages_per_range = 64);

-- =============================================================================
-- 7. INDEXES — HOT STORE
-- =============================================================================
-- Hot tables have only the PRIMARY KEY index (on device ID).
-- At 10K-20K rows, any additional index is pure overhead.
-- The PK already serves:
--   - Point lookups by device ID (UPSERT conflict target)
--   - Sequential scan of the entire table is <1ms at 20K rows

-- =============================================================================
-- 8. INDEXES — ROLLUP TABLES
-- =============================================================================

CREATE INDEX idx_vehicle_hourly_bucket
    ON vehicle_hourly_stats (hour_bucket);

CREATE INDEX idx_meter_hourly_bucket
    ON meter_hourly_stats (hour_bucket);

-- =============================================================================
-- 9. MONTHLY PARTITIONS — 2026
-- =============================================================================
-- WHY MONTHLY (not daily)?
-- With daily partitions: 365 child tables/year. At scale, the planner must
-- evaluate each partition during planning. Monthly = 12 partitions/year,
-- keeping the planning overhead minimal while still providing effective
-- pruning. A month of data (~840M rows for vehicles + meters) is large
-- but manageable with BRIN + the composite B-tree within each partition.
--
-- For retention: DROP an entire monthly partition instantly vs DELETE
-- millions of rows with WAL bloat and VACUUM pressure.

-- Vehicle History Partitions
CREATE TABLE vehicle_telemetry_history_2026_01 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE vehicle_telemetry_history_2026_02 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE vehicle_telemetry_history_2026_03 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE vehicle_telemetry_history_2026_04 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE vehicle_telemetry_history_2026_05 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE vehicle_telemetry_history_2026_06 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE vehicle_telemetry_history_2026_07 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE vehicle_telemetry_history_2026_08 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE vehicle_telemetry_history_2026_09 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE vehicle_telemetry_history_2026_10 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE vehicle_telemetry_history_2026_11 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE TABLE vehicle_telemetry_history_2026_12 PARTITION OF vehicle_telemetry_history
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- Meter History Partitions
CREATE TABLE meter_telemetry_history_2026_01 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');

CREATE TABLE meter_telemetry_history_2026_02 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');

CREATE TABLE meter_telemetry_history_2026_03 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');

CREATE TABLE meter_telemetry_history_2026_04 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');

CREATE TABLE meter_telemetry_history_2026_05 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');

CREATE TABLE meter_telemetry_history_2026_06 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');

CREATE TABLE meter_telemetry_history_2026_07 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

CREATE TABLE meter_telemetry_history_2026_08 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');

CREATE TABLE meter_telemetry_history_2026_09 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

CREATE TABLE meter_telemetry_history_2026_10 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');

CREATE TABLE meter_telemetry_history_2026_11 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');

CREATE TABLE meter_telemetry_history_2026_12 PARTITION OF meter_telemetry_history
    FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- =============================================================================
-- 10. DEFAULT PARTITIONS (Catch-All Safety Net)
-- =============================================================================
-- Any record with a timestamp outside the defined range lands here
-- instead of throwing an error. Monitor this table — if rows appear,
-- you need to create new partitions.

CREATE TABLE vehicle_telemetry_history_default PARTITION OF vehicle_telemetry_history DEFAULT;
CREATE TABLE meter_telemetry_history_default PARTITION OF meter_telemetry_history DEFAULT;

-- =============================================================================
-- 11. PARTITION MANAGEMENT — AUTO-CREATE NEXT MONTH
-- =============================================================================
-- Run this via pg_cron or application-level scheduler on the 1st of each month.
-- Creates partitions 2 months ahead so you never miss one.

-- Example: Creating January 2027 partitions
-- CREATE TABLE vehicle_telemetry_history_2027_01 PARTITION OF vehicle_telemetry_history
--     FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');
-- CREATE TABLE meter_telemetry_history_2027_01 PARTITION OF meter_telemetry_history
--     FOR VALUES FROM ('2027-01-01') TO ('2027-02-01');

-- =============================================================================
-- 12. UPSERT PATTERNS — HOT STORE
-- =============================================================================
-- These are not table definitions — they are the INSERT patterns
-- the application layer must use. Included here as executable reference.

-- Vehicle UPSERT: Only update if incoming reading is newer
-- This prevents out-of-order messages from overwriting fresher data.

-- PREPARE vehicle_upsert AS
-- INSERT INTO vehicle_current_status (vehicle_id, soc, kwh_delivered_dc, battery_temp, last_seen_at, updated_at)
-- VALUES ($1, $2, $3, $4, $5, NOW())
-- ON CONFLICT (vehicle_id) DO UPDATE SET
--     soc              = EXCLUDED.soc,
--     kwh_delivered_dc = EXCLUDED.kwh_delivered_dc,
--     battery_temp     = EXCLUDED.battery_temp,
--     last_seen_at     = EXCLUDED.last_seen_at,
--     updated_at       = NOW()
-- WHERE vehicle_current_status.last_seen_at < EXCLUDED.last_seen_at;

-- Meter UPSERT: Same pattern
-- PREPARE meter_upsert AS
-- INSERT INTO meter_current_status (meter_id, kwh_consumed_ac, voltage, last_seen_at, updated_at)
-- VALUES ($1, $2, $3, $4, NOW())
-- ON CONFLICT (meter_id) DO UPDATE SET
--     kwh_consumed_ac  = EXCLUDED.kwh_consumed_ac,
--     voltage          = EXCLUDED.voltage,
--     last_seen_at     = EXCLUDED.last_seen_at,
--     updated_at       = NOW()
-- WHERE meter_current_status.last_seen_at < EXCLUDED.last_seen_at;

-- =============================================================================
-- 13. RETENTION — PARTITION DROP EXAMPLE
-- =============================================================================
-- To remove data older than 6 months, detach and drop the partition.
-- This is O(1) — no row-by-row DELETE, no VACUUM needed.

-- Step 1: Detach (non-blocking in PG 14+)
-- ALTER TABLE vehicle_telemetry_history DETACH PARTITION vehicle_telemetry_history_2025_08 CONCURRENTLY;
-- ALTER TABLE meter_telemetry_history DETACH PARTITION meter_telemetry_history_2025_08 CONCURRENTLY;

-- Step 2: Optional — export to S3/Parquet for long-term archive
-- Step 3: Drop
-- DROP TABLE vehicle_telemetry_history_2025_08;
-- DROP TABLE meter_telemetry_history_2025_08;

-- =============================================================================
-- 14. POSTGRESQL CONFIGURATION RECOMMENDATIONS
-- =============================================================================
-- These are not SQL — they go in postgresql.conf.
-- Included here for completeness.
--
-- shared_buffers          = 8GB          -- 25% of RAM on a 32GB machine
-- effective_cache_size    = 24GB         -- 75% of RAM
-- work_mem                = 64MB         -- per-operation sort/hash memory
-- maintenance_work_mem    = 2GB          -- for VACUUM, CREATE INDEX
-- wal_level               = replica      -- enable streaming replication
-- max_wal_size            = 4GB          -- high WAL throughput for bulk inserts
-- checkpoint_completion_target = 0.9     -- spread checkpoint writes
-- random_page_cost        = 1.1          -- SSD-optimized (default 4.0 is for HDD)
-- effective_io_concurrency = 200         -- SSD concurrent read requests
-- autovacuum_max_workers  = 6            -- more workers for partitioned tables
-- autovacuum_naptime      = 30s          -- check more frequently
-- max_parallel_workers_per_gather = 4    -- parallel query for analytics
-- =============================================================================

-- =============================================================================
-- 15. MATERIALIZED VIEW — VEHICLE PERFORMANCE (24h)
-- =============================================================================
-- Pre-computes the performance summary that the /v1/analytics/performance/:vehicleId
-- endpoint returns. Refreshed every 15 minutes via pg_cron.
--
-- WHY MATERIALIZED VIEW?
-- The raw query hits two partitioned history tables + a join through
-- vehicle_meter_link. Even with indexes, this is ~1440 rows per device
-- per day (1 reading/min x 24h). For a dashboard polling every 5 seconds,
-- re-running this query is wasteful. The MATVIEW serves pre-computed results
-- at index-scan speed.
--
-- REFRESH CONCURRENTLY requires a UNIQUE index on the view.

CREATE MATERIALIZED VIEW IF NOT EXISTS mv_vehicle_performance_24h AS
SELECT
    vml.vehicle_id,
    vml.meter_id,
    COALESCE(SUM(m.kwh_consumed_ac), 0)       AS total_ac_consumed,
    COALESCE(SUM(v.kwh_delivered_dc), 0)       AS total_dc_delivered,
    CASE
        WHEN SUM(m.kwh_consumed_ac) > 0
        THEN ROUND(SUM(v.kwh_delivered_dc) / SUM(m.kwh_consumed_ac) * 100, 2)
        ELSE 0
    END                                         AS efficiency_ratio,
    ROUND(AVG(v.battery_temp), 2)               AS avg_battery_temp
FROM vehicle_meter_link vml
JOIN vehicle_telemetry_history v
    ON v.vehicle_id = vml.vehicle_id
   AND v.recorded_at >= NOW() - INTERVAL '24 hours'
JOIN meter_telemetry_history m
    ON m.meter_id = vml.meter_id
   AND m.recorded_at >= NOW() - INTERVAL '24 hours'
GROUP BY vml.vehicle_id, vml.meter_id
WITH NO DATA;  -- Populated on first REFRESH

CREATE UNIQUE INDEX idx_mv_vehicle_perf_24h_vid
    ON mv_vehicle_performance_24h (vehicle_id);

-- Refresh command (run via pg_cron every 15 minutes):
-- REFRESH MATERIALIZED VIEW CONCURRENTLY mv_vehicle_performance_24h;
-- =============================================================================
