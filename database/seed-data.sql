-- =============================================================================
-- SEED DATA — Energy Ingestion Engine
-- =============================================================================
-- Initial sample data for development and testing
--
-- Usage:
--   docker exec -i energy_postgres psql -U postgres -d energy_engine < database/seed-data.sql
--
-- Or from inside the container:
--   psql -U postgres -d energy_engine -f /path/to/seed-data.sql
-- =============================================================================

\echo '========================================'
\echo 'Inserting seed data...'
\echo '========================================'

-- Clear existing data (optional - comment out if you want to keep existing data)
TRUNCATE TABLE vehicle_current_status CASCADE;
TRUNCATE TABLE meter_current_status CASCADE;
TRUNCATE TABLE vehicle_meter_link CASCADE;
TRUNCATE TABLE vehicle_telemetry_history CASCADE;
TRUNCATE TABLE meter_telemetry_history CASCADE;

-- ============================================================================
-- VEHICLE CURRENT STATUS (Hot Store)
-- ============================================================================
\echo 'Inserting vehicle current status data...'

INSERT INTO vehicle_current_status (vehicle_id, soc, kwh_delivered_dc, battery_temp, last_seen_at, updated_at)
VALUES
    ('V001', 72.50, 3.21, 31.40, NOW() - INTERVAL '5 minutes', NOW()),
    ('V002', 85.30, 5.45, 29.80, NOW() - INTERVAL '3 minutes', NOW()),
    ('V003', 45.60, 2.15, 33.20, NOW() - INTERVAL '10 minutes', NOW()),
    ('V004', 91.20, 6.78, 28.50, NOW() - INTERVAL '2 minutes', NOW()),
    ('V005', 38.90, 1.89, 35.10, NOW() - INTERVAL '8 minutes', NOW()),
    ('V006', 67.40, 4.32, 30.60, NOW() - INTERVAL '6 minutes', NOW()),
    ('V007', 55.80, 3.67, 32.30, NOW() - INTERVAL '4 minutes', NOW()),
    ('V008', 78.20, 5.12, 29.90, NOW() - INTERVAL '7 minutes', NOW()),
    ('V009', 82.50, 5.89, 31.70, NOW() - INTERVAL '1 minute', NOW()),
    ('V010', 49.30, 2.98, 34.50, NOW() - INTERVAL '9 minutes', NOW());

\echo 'Inserted 10 vehicle records into vehicle_current_status'

-- ============================================================================
-- METER CURRENT STATUS (Hot Store)
-- ============================================================================
\echo 'Inserting meter current status data...'

INSERT INTO meter_current_status (meter_id, kwh_consumed_ac, voltage, last_seen_at, updated_at)
VALUES
    ('M001', 4.15, 232.10, NOW() - INTERVAL '5 minutes', NOW()),
    ('M002', 6.28, 230.50, NOW() - INTERVAL '3 minutes', NOW()),
    ('M003', 2.89, 233.20, NOW() - INTERVAL '10 minutes', NOW()),
    ('M004', 7.45, 231.80, NOW() - INTERVAL '2 minutes', NOW()),
    ('M005', 2.12, 234.10, NOW() - INTERVAL '8 minutes', NOW()),
    ('M006', 5.02, 232.60, NOW() - INTERVAL '6 minutes', NOW()),
    ('M007', 4.23, 231.20, NOW() - INTERVAL '4 minutes', NOW()),
    ('M008', 5.89, 230.90, NOW() - INTERVAL '7 minutes', NOW()),
    ('M009', 6.55, 233.50, NOW() - INTERVAL '1 minute', NOW()),
    ('M010', 3.45, 232.30, NOW() - INTERVAL '9 minutes', NOW());

\echo 'Inserted 10 meter records into meter_current_status'

-- ============================================================================
-- VEHICLE-METER LINKS
-- ============================================================================
\echo 'Inserting vehicle-meter links...'

INSERT INTO vehicle_meter_link (vehicle_id, meter_id, linked_at)
VALUES
    ('V001', 'M001', NOW() - INTERVAL '1 day'),
    ('V002', 'M002', NOW() - INTERVAL '1 day'),
    ('V003', 'M003', NOW() - INTERVAL '1 day'),
    ('V004', 'M004', NOW() - INTERVAL '1 day'),
    ('V005', 'M005', NOW() - INTERVAL '1 day'),
    ('V006', 'M006', NOW() - INTERVAL '1 day'),
    ('V007', 'M007', NOW() - INTERVAL '1 day'),
    ('V008', 'M008', NOW() - INTERVAL '1 day'),
    ('V009', 'M009', NOW() - INTERVAL '1 day'),
    ('V010', 'M010', NOW() - INTERVAL '1 day');

\echo 'Inserted 10 vehicle-meter links'

-- ============================================================================
-- VEHICLE TELEMETRY HISTORY (Cold Store)
-- ============================================================================
\echo 'Inserting vehicle telemetry history data...'

-- Generate historical data for the last 24 hours (one reading per hour per vehicle)
INSERT INTO vehicle_telemetry_history (vehicle_id, soc, kwh_delivered_dc, battery_temp, recorded_at)
SELECT
    'V00' || vehicle_num::text,
    50 + (random() * 40)::numeric(5,2),  -- SOC between 50-90%
    (random() * 5)::numeric(10,4),        -- kWh between 0-5
    25 + (random() * 15)::numeric(5,2),   -- Temp between 25-40°C
    NOW() - (hour_offset || ' hours')::interval
FROM
    generate_series(1, 10) AS vehicle_num,
    generate_series(0, 23) AS hour_offset;

\echo 'Inserted 240 historical vehicle readings (10 vehicles × 24 hours)'

-- ============================================================================
-- METER TELEMETRY HISTORY (Cold Store)
-- ============================================================================
\echo 'Inserting meter telemetry history data...'

-- Generate historical data for the last 24 hours (one reading per hour per meter)
INSERT INTO meter_telemetry_history (meter_id, kwh_consumed_ac, voltage, recorded_at)
SELECT
    'M00' || meter_num::text,
    (random() * 7)::numeric(10,4),        -- kWh between 0-7
    228 + (random() * 8)::numeric(6,2),   -- Voltage between 228-236V
    NOW() - (hour_offset || ' hours')::interval
FROM
    generate_series(1, 10) AS meter_num,
    generate_series(0, 23) AS hour_offset;

\echo 'Inserted 240 historical meter readings (10 meters × 24 hours)'

-- ============================================================================
-- VERIFICATION
-- ============================================================================
\echo ''
\echo '========================================'
\echo 'Seed data insertion complete!'
\echo '========================================'
\echo ''
\echo 'Data Summary:'
SELECT 'vehicle_current_status' AS table_name, COUNT(*) AS row_count FROM vehicle_current_status
UNION ALL
SELECT 'meter_current_status', COUNT(*) FROM meter_current_status
UNION ALL
SELECT 'vehicle_meter_link', COUNT(*) FROM vehicle_meter_link
UNION ALL
SELECT 'vehicle_telemetry_history', COUNT(*) FROM vehicle_telemetry_history
UNION ALL
SELECT 'meter_telemetry_history', COUNT(*) FROM meter_telemetry_history;

\echo ''
\echo 'Sample queries to verify data:'
\echo '  SELECT * FROM vehicle_current_status LIMIT 5;'
\echo '  SELECT * FROM meter_current_status LIMIT 5;'
\echo '  SELECT * FROM vehicle_telemetry_history WHERE vehicle_id = ''V001'' ORDER BY recorded_at DESC LIMIT 10;'
\echo ''
