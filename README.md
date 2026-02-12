# Energy Ingestion Engine

A high-scale telemetry ingestion system built with **NestJS**, **PostgreSQL**, and **PgBouncer**, designed to ingest and analyze **28 million+ records per day** from 10,000 smart meters and 10,000 EV vehicles.

---

## Table of Contents

- [Architecture](#architecture)
- [Data Flow](#data-flow)
- [Hot vs Cold Storage](#hot-vs-cold-storage)
- [Insert vs Upsert Strategy](#insert-vs-upsert-strategy)
- [Index Strategy](#index-strategy)
- [Partitioning Strategy](#partitioning-strategy)
- [How Analytics Avoids Full Scans](#how-analytics-avoids-full-scans)
- [Scalability](#scalability)
- [API Documentation](#api-documentation)
- [Running with Docker](#running-with-docker)
- [Project Structure](#project-structure)
- [Future Improvements](#future-improvements)

---

## Architecture

```
  10K Smart Meters ─┐                 ┌──────────────────────────────────────┐
                    │   HTTP POST     │          NestJS (Fastify)            │
                    ├────────────────►│                                      │
                    │  /v1/telemetry  │  ┌──────────────────────────────┐    │
  10K EV Vehicles ──┘                 │  │    In-Memory Write Buffer    │    │
                                      │  │  (flush: 500 records / 2s)   │    │
                                      │  └─────────┬──────────┬────────┘     │
                                      └────────────┼──────────┼──────────────┘
                                                   │          │
                                      ┌────────────▼──┐  ┌───▼──────────────┐
                                      │  HOT STORE    │  │   COLD STORE     │
                                      │               │  │                  │
                                      │ UPSERT latest │  │ INSERT-ONLY      │
                                      │ state per     │  │ append history   │
                                      │ device        │  │                  │
                                      │               │  │ Partitioned by   │
                                      │ ~20K rows     │  │ month            │
                                      │ (fixed)       │  │ ~28M rows/day    │
                                      └───────────────┘  └──────────────────┘
                                              │                   │
                                      ┌───────▼───────────────────▼────────┐
                                      │       PRE-AGGREGATED ROLLUPS       │
                                      │  hourly_stats tables + mat. views  │
                                      │                                    │
                                      │  Dashboard queries land HERE,      │
                                      │  never on raw history tables       │
                                      └────────────────────────────────────┘
```

### Complete System Flowchart — Tables, Partitions, Relations & API Endpoints

```
╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║                                    API ENDPOINTS & DATA FLOW                                    ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════╝

┌─ WRITE ENDPOINTS ────────────────────────────────────────────────────────────────────────────────┐
│                                                                                                  │
│  POST /v1/telemetry                                    GET /v1/telemetry/buffer-status           │
│  ┌────────────────────────────────────────────┐        ┌──────────────────────────────────┐      │
│  │ Request (Vehicle):                         │        │ Response:                        │      │
│  │ {                                          │        │ { "vehicles": 142, "meters": 87 }│      │
│  │   "type": "VEHICLE",                       │        └──────────────────────────────────┘      │
│  │   "payload": {                             │                       ▲                          │
│  │     "vehicleId": "V001",                   │                       │ reads count              │
│  │     "soc": 72.50,                          │                       │                          │
│  │     "kwhDeliveredDc": 3.21,                │        ┌──────────────┴───────────────────┐      │
│  │     "batteryTemp": 31.40,                  │        │   IngestionBufferService         │      │
│  │     "timestamp": "2026-02-12T10:30:00Z"    │        │   (in-memory buffer)             │      │
│  │   }                                        │        │                                  │      │
│  │ }                                          │        │   flush: 500 records OR 2 seconds│      │
│  │                                            │        │   whichever comes first          │      │
│  │ Request (Meter):                           │        └──────────┬───────────────────────┘      │
│  │ {                                          │                   │                              │
│  │   "type": "METER",                         │                   │ batch flush                  │
│  │   "payload": {                             │                   │                              │
│  │     "meterId": "M042",                     │                   ▼                              │
│  │     "kwhConsumedAc": 4.15,                 │        ┌──────────────────────────────────┐      │
│  │     "voltage": 232.10,                     │        │ Single SQL Transaction:          │      │
│  │     "timestamp": "2026-02-12T10:30:00Z"    │        │  1. INSERT INTO history (cold)   │      │
│  │   }                                        │        │  2. INSERT..ON CONFLICT (hot)    │      │
│  │ }                                          │        └──────────┬───────────┬───────────┘      │
│  │                                            │                   │           │                  │
│  │ Response: 202 Accepted                     │                   │           │                  │
│  │ { "accepted": true }                       │                   │           │                  │
│  └────────────────────────────────────────────┘                   │           │                  │
└───────────────────────────────────────────────────────────────────┼───────────┼──────────────────┘
                                                                    │           │
                              ┌─────────────────────────────────────┘           │
                              │ INSERT (append-only)                            │ UPSERT
                              ▼                                                 ▼

╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║                            COLD STORE — Partitioned History Tables                               ║
║                            (Insert-Only │ ~28M rows/day │ ~840M rows/month)                      ║
╠══════════════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                                  ║
║  vehicle_telemetry_history (partitioned parent)                                                  ║
║  ┌───────────────────────────────────────────────────────────────────────────────────┐           ║
║  │ Columns: id BIGINT, vehicle_id VARCHAR(64), soc NUMERIC(5,2),                     │           ║
║  │          kwh_delivered_dc NUMERIC(10,4), battery_temp NUMERIC(5,2),               │           ║
║  │          recorded_at TIMESTAMPTZ, ingested_at TIMESTAMPTZ                         │           ║
║  │ PK: (recorded_at, id) │ PARTITION BY RANGE (recorded_at)                          │           ║
║  │ Indexes: (vehicle_id, recorded_at DESC) B-tree, (recorded_at) BRIN,               │           ║
║  │          (ingested_at) BRIN                                                       │           ║
║  ├───────────────────────────────────────────────────────────────────────────────────┤           ║
║  │                                                                                   │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ vehicle_telemetry_history_2026_01   │  │ vehicle_telemetry_history_2026_02   │ │           ║
║  │  │ Jan 2026                            │  │ Feb 2026 ← ACTIVE WRITES            │ │           ║
║  │  │ FROM '2026-01-01' TO '2026-02-01'   │  │ FROM '2026-02-01' TO '2026-03-01'   │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ vehicle_telemetry_history_2026_03   │  │ vehicle_telemetry_history_2026_04   │ │           ║
║  │  │ Mar 2026                            │  │ Apr 2026                            │ │           ║
║  │  │ FROM '2026-03-01' TO '2026-04-01'   │  │ FROM '2026-04-01' TO '2026-05-01'   │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ vehicle_telemetry_history_2026_05   │  │ vehicle_telemetry_history_2026_06   │ │           ║
║  │  │ May 2026                            │  │ Jun 2026                            │ │           ║
║  │  │ FROM '2026-05-01' TO '2026-06-01'   │  │ FROM '2026-06-01' TO '2026-07-01'   │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ vehicle_telemetry_history_2026_07   │  │ vehicle_telemetry_history_2026_08   │ │           ║
║  │  │ Jul 2026                            │  │ Aug 2026                            │ │           ║
║  │  │ FROM '2026-07-01' TO '2026-08-01'   │  │ FROM '2026-08-01' TO '2026-09-01'   │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ vehicle_telemetry_history_2026_09   │  │ vehicle_telemetry_history_2026_10   │ │           ║
║  │  │ Sep 2026                            │  │ Oct 2026                            │ │           ║
║  │  │ FROM '2026-09-01' TO '2026-10-01'   │  │ FROM '2026-10-01' TO '2026-11-01'   │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ vehicle_telemetry_history_2026_11   │  │ vehicle_telemetry_history_2026_12   │ │           ║
║  │  │ Nov 2026                            │  │ Dec 2026                            │ │           ║
║  │  │ FROM '2026-11-01' TO '2026-12-01'   │  │ FROM '2026-12-01' TO '2027-01-01'   │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐                                          │           ║
║  │  │ vehicle_telemetry_history_default   │  ◄── catch-all for out-of-range dates    │           ║
║  │  └─────────────────────────────────────┘                                          │           ║
║  └───────────────────────────────────────────────────────────────────────────────────┘           ║
║                                                                                                  ║
║  meter_telemetry_history (partitioned parent)                                                    ║
║  ┌───────────────────────────────────────────────────────────────────────────────────┐           ║
║  │ Columns: id BIGINT, meter_id VARCHAR(64), kwh_consumed_ac NUMERIC(10,4),          │           ║
║  │          voltage NUMERIC(6,2), recorded_at TIMESTAMPTZ, ingested_at TIMESTAMPTZ   │           ║
║  │ PK: (recorded_at, id) │ PARTITION BY RANGE (recorded_at)                          │           ║
║  │ Indexes: (meter_id, recorded_at DESC) B-tree, (recorded_at) BRIN,                 │           ║
║  │          (ingested_at) BRIN                                                       │           ║
║  ├───────────────────────────────────────────────────────────────────────────────────┤           ║
║  │                                                                                   │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ meter_telemetry_history_2026_01     │  │ meter_telemetry_history_2026_02     │ │           ║
║  │  │ Jan 2026                            │  │ Feb 2026 ← ACTIVE WRITES            │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ meter_telemetry_history_2026_03     │  │ meter_telemetry_history_2026_04     │ │           ║
║  │  │ Mar 2026                            │  │ Apr 2026                            │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ meter_telemetry_history_2026_05     │  │ meter_telemetry_history_2026_06     │ │           ║
║  │  │ May 2026                            │  │ Jun 2026                            │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ meter_telemetry_history_2026_07     │  │ meter_telemetry_history_2026_08     │ │           ║
║  │  │ Jul 2026                            │  │ Aug 2026                            │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ meter_telemetry_history_2026_09     │  │ meter_telemetry_history_2026_10     │ │           ║
║  │  │ Sep 2026                            │  │ Oct 2026                            │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐  ┌─────────────────────────────────────┐ │           ║
║  │  │ meter_telemetry_history_2026_11     │  │ meter_telemetry_history_2026_12     │ │           ║
║  │  │ Nov 2026                            │  │ Dec 2026                            │ │           ║
║  │  └─────────────────────────────────────┘  └─────────────────────────────────────┘ │           ║
║  │  ┌─────────────────────────────────────┐                                          │           ║
║  │  │ meter_telemetry_history_default     │  ◄── catch-all for out-of-range dates    │           ║
║  │  └─────────────────────────────────────┘                                          │           ║
║  └───────────────────────────────────────────────────────────────────────────────────┘           ║
╚══════════════════════════════════════╤═══════════════════════════════════════════════════════════╝
                                       │
                                       │ Aggregated every 15 min (pg_cron)
                                       ▼

╔═════════════════════════════════════════════════════════════════════════════════════════════════╗
║                            HOT STORE — Current Status Tables                                    ║
║                            (Upsert │ ~20K rows fixed │ sub-millisecond reads)                   ║
╠═════════════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                                 ║
║  vehicle_current_status                          meter_current_status                           ║
║  ┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐       ║
║  │ vehicle_id      VARCHAR(64) PK ◄──┐  │        │ meter_id        VARCHAR(64) PK ◄──┐  │       ║
║  │ soc             NUMERIC(5,2)      │  │        │ kwh_consumed_ac NUMERIC(10,4)     │  │       ║
║  │ kwh_delivered_dc NUMERIC(10,4)    │  │        │ voltage         NUMERIC(6,2)      │  │       ║
║  │ battery_temp    NUMERIC(5,2)      │  │        │ last_seen_at    TIMESTAMPTZ       │  │       ║
║  │ last_seen_at    TIMESTAMPTZ       │  │        │ updated_at      TIMESTAMPTZ       │  │       ║
║  │ updated_at      TIMESTAMPTZ       │  │        └───────────────────────────────────┘  │       ║
║  └───────────────────────────────────┘  │        ~10K rows │ PK index only              │       ║
║  ~10K rows │ PK index only              │                                               │       ║
║                                         │                                               │       ║
║  ═══════════════════════════════════════╪═══════════════════════════════════════════════╪═══    ║
║                                         │          FOREIGN KEY REFERENCES               │       ║
║                                         │                                               │       ║
║  vehicle_meter_link                     │                                               │       ║
║  ┌─────────────────────────────────────┐│                                               │       ║
║  │ vehicle_id  VARCHAR(64) PK ─────────┘  (FK → vehicle_current_status.vehicle_id)      │       ║
║  │ meter_id    VARCHAR(64) ─────────────────────(FK → meter_current_status.meter_id) ───┘       ║
║  │ linked_at   TIMESTAMPTZ              │                                                       ║
║  └──────────────────────────────────────┘                                                       ║
║  ~10K rows │ Maps each vehicle to its charging meter                                            ║
║  IDX: (meter_id)                                                                                ║
╚═════════════════════════════════════════════════════════════════════════════════════════════════╝


╔═════════════════════════════════════════════════════════════════════════════════════════════════╗
║                            ROLLUP TABLES — Pre-Aggregated Analytics                             ║
║                            (~10K devices x 24 hours = ~240K rows)                               ║
╠═════════════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                                 ║
║  vehicle_hourly_stats                            meter_hourly_stats                             ║
║  ┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐       ║
║  │ vehicle_id       VARCHAR(64)         │        │ meter_id          VARCHAR(64)        │       ║
║  │ hour_bucket      TIMESTAMPTZ         │        │ hour_bucket       TIMESTAMPTZ        │       ║
║  │ reading_count    INTEGER             │        │ reading_count     INTEGER            │       ║
║  │ avg_soc          NUMERIC(5,2)        │        │ total_kwh_ac      NUMERIC(12,4)      │       ║
║  │ min_soc          NUMERIC(5,2)        │        │ avg_voltage       NUMERIC(6,2)       │       ║
║  │ max_soc          NUMERIC(5,2)        │        │ min_voltage       NUMERIC(6,2)       │       ║
║  │ total_kwh_dc     NUMERIC(12,4)       │        │ max_voltage       NUMERIC(6,2)       │       ║
║  │ avg_battery_temp NUMERIC(5,2)        │        ├──────────────────────────────────────┤       ║
║  │ max_battery_temp NUMERIC(5,2)        │        │ PK: (meter_id, hour_bucket)          │       ║
║  ├──────────────────────────────────────┤        │ IDX: (hour_bucket)                   │       ║
║  │ PK: (vehicle_id, hour_bucket)        │        └──────────────────────────────────────┘       ║
║  │ IDX: (hour_bucket)                   │                                                       ║
║  └──────────────────────────────────────┘                                                       ║
║                                                   Aggregated FROM: vehicle_telemetry_history    ║
║  Aggregated FROM: vehicle_telemetry_history       and meter_telemetry_history (cold store)      ║
║  (cold store partitions)                                                                        ║
║                                                                                                 ║
║  ┌───────────────────────────────────────────────────────────────────────────────────────┐      ║
║  │ mv_vehicle_performance_24h (MATERIALIZED VIEW)                                        │      ║
║  │                                                                                       │      ║
║  │ Columns: vehicle_id (UNIQUE), meter_id, total_ac_consumed, total_dc_delivered,        │      ║
║  │          efficiency_ratio, avg_battery_temp                                           │      ║
║  │                                                                                       │      ║
║  │ SOURCE: JOIN vehicle_meter_link + vehicle_telemetry_history + meter_telemetry_history │      ║
║  │         WHERE recorded_at >= NOW() - INTERVAL '24 hours'                              │      ║
║  │                                                                                       │      ║
║  │ REFRESH: Every 15 min via pg_cron (REFRESH MATERIALIZED VIEW CONCURRENTLY)            │      ║
║  └───────────────────────────────────────────────────────────────────────────────────────┘      ║
╚═════════════════════════════════════════════════════════════════════════════════════════════════╝


╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║                            READ ENDPOINTS — API → Table Mapping                                  ║
╠══════════════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                                  ║
║  GET /v1/analytics/live/:deviceType/:deviceId                                                    ║
║  ┌──────────────────────────────────────────────────────────────────────────────────────┐        ║
║  │ Example: GET /v1/analytics/live/VEHICLE/V001                                         │        ║
║  │ Reads:   vehicle_current_status (HOT) ──► PK lookup on vehicle_id                    │        ║
║  │ Latency: <1ms │ Rows: 1                                                              │        ║
║  │ Response: { "vehicle_id":"V001", "soc":72.50, "kwh_delivered_dc":3.21,               │        ║
║  │             "battery_temp":31.40, "last_seen_at":"2026-02-12T10:30:00Z" }            │        ║
║  └──────────────────────────────────────────────────────────────────────────────────────┘        ║
║                                                                                                  ║
║  GET /v1/analytics/history?deviceType=...&deviceId=...&from=...&to=...&limit=100                 ║
║  ┌──────────────────────────────────────────────────────────────────────────────────────┐        ║
║  │ Example: GET /v1/analytics/history?deviceType=VEHICLE&deviceId=V001                  │        ║
║  │          &from=2026-02-11T00:00:00Z&to=2026-02-12T00:00:00Z&limit=100                │        ║
║  │ Reads:   vehicle_telemetry_history (COLD)                                            │        ║
║  │          ──► Partition pruning: skips 10 of 12 monthly partitions                    │        ║
║  │          ──► Index scan: (vehicle_id, recorded_at DESC)                              │        ║
║  │ Latency: 2-8ms │ Rows: ~1440                                                         │        ║
║  │ Response: [{ "vehicle_id":"V001", "soc":72.50, "recorded_at":"..." }, ...]           │        ║
║  └──────────────────────────────────────────────────────────────────────────────────────┘        ║
║                                                                                                  ║
║  GET /v1/analytics/fleet-summary?deviceType=...&from=...&to=...                                  ║
║  ┌──────────────────────────────────────────────────────────────────────────────────────┐        ║
║  │ Example: GET /v1/analytics/fleet-summary?deviceType=VEHICLE                          │        ║
║  │          &from=2026-02-11T00:00:00Z&to=2026-02-12T00:00:00Z                          │        ║
║  │ Reads:   vehicle_hourly_stats (ROLLUP) ──► hour_bucket index scan                    │        ║
║  │ Latency: 10-50ms │ Rows: ~240K                                                       │        ║
║  │ Response: [{ "hour":"2026-02-12T09:00:00Z", "active_vehicles":8742,                  │        ║
║  │              "fleet_avg_soc":64.21, "fleet_total_kwh_dc":42850.12 }]                 │        ║
║  └──────────────────────────────────────────────────────────────────────────────────────┘        ║
║                                                                                                  ║
║  GET /v1/analytics/last-24h/:deviceType                                                          ║
║  ┌──────────────────────────────────────────────────────────────────────────────────────┐        ║
║  │ Example: GET /v1/analytics/last-24h/VEHICLE                                          │        ║
║  │ Reads:   vehicle_hourly_stats (ROLLUP) ──► hour_bucket index scan                    │        ║
║  │ Latency: 5-20ms │ Rows: ~24 (one per hour)                                           │        ║
║  │ Response: [{ "hour":"2026-02-12T09:00:00Z", "total_vehicles":10000,                  │        ║
║  │              "avg_soc":65.30, "total_kwh_dc":42850.12 }]                             │        ║
║  └──────────────────────────────────────────────────────────────────────────────────────┘        ║
║                                                                                                  ║
║  GET /v1/analytics/performance/:vehicleId                                                        ║
║  ┌──────────────────────────────────────────────────────────────────────────────────────┐        ║
║  │ Example: GET /v1/analytics/performance/V001                                          │        ║
║  │ Reads:   vehicle_meter_link ──► PK lookup (vehicle_id)                               │        ║
║  │          vehicle_telemetry_history (COLD) ──► index scan (vehicle_id, recorded_at)   │        ║
║  │          meter_telemetry_history (COLD) ──► index scan (meter_id, recorded_at)       │        ║
║  │          Joined via CTE using vehicle_meter_link.meter_id                            │        ║
║  │ Latency: 3-8ms │ Rows: ~2880 (1440 vehicle + 1440 meter)                             │        ║
║  │ Response: { "vehicleId":"V001", "meterId":"M042", "totalAcConsumed":85.50,           │        ║
║  │             "totalDcDelivered":76.32, "efficiencyRatio":89.26,                       │        ║
║  │             "averageBatteryTemp":32.50 }                                             │        ║
║  └──────────────────────────────────────────────────────────────────────────────────────┘        ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════╝


╔══════════════════════════════════════════════════════════════════════════════════════════════════╗
║                            TABLE RELATIONSHIP MAP                                                ║
╠══════════════════════════════════════════════════════════════════════════════════════════════════╣
║                                                                                                  ║
║  vehicle_telemetry_history ─── PARTITION OF ──┬── vehicle_telemetry_history_2026_01              ║
║                                               ├── vehicle_telemetry_history_2026_02              ║
║                                               ├── vehicle_telemetry_history_2026_03              ║
║                                               ├── vehicle_telemetry_history_2026_04              ║
║                                               ├── vehicle_telemetry_history_2026_05              ║
║                                               ├── vehicle_telemetry_history_2026_06              ║
║                                               ├── vehicle_telemetry_history_2026_07              ║
║                                               ├── vehicle_telemetry_history_2026_08              ║
║                                               ├── vehicle_telemetry_history_2026_09              ║
║                                               ├── vehicle_telemetry_history_2026_10              ║
║                                               ├── vehicle_telemetry_history_2026_11              ║
║                                               ├── vehicle_telemetry_history_2026_12              ║
║                                               └── vehicle_telemetry_history_default              ║
║                                                                                                  ║
║  meter_telemetry_history ──── PARTITION OF ──┬── meter_telemetry_history_2026_01                 ║
║                                              ├── meter_telemetry_history_2026_02                 ║
║                                              ├── meter_telemetry_history_2026_03                 ║
║                                              ├── meter_telemetry_history_2026_04                 ║
║                                              ├── meter_telemetry_history_2026_05                 ║
║                                              ├── meter_telemetry_history_2026_06                 ║
║                                              ├── meter_telemetry_history_2026_07                 ║
║                                              ├── meter_telemetry_history_2026_08                 ║
║                                              ├── meter_telemetry_history_2026_09                 ║
║                                              ├── meter_telemetry_history_2026_10                 ║
║                                              ├── meter_telemetry_history_2026_11                 ║
║                                              ├── meter_telemetry_history_2026_12                 ║
║                                              └── meter_telemetry_history_default                 ║
║                                                                                                  ║
║  vehicle_meter_link.vehicle_id ──── FK ────► vehicle_current_status.vehicle_id (PK)              ║
║  vehicle_meter_link.meter_id ────── FK ────► meter_current_status.meter_id (PK)                  ║
║                                                                                                  ║
║  vehicle_hourly_stats ──── AGGREGATED FROM ────► vehicle_telemetry_history (cold)                ║
║  meter_hourly_stats ────── AGGREGATED FROM ────► meter_telemetry_history (cold)                  ║
║                                                                                                  ║
║  mv_vehicle_performance_24h ── JOINS ──┬──► vehicle_meter_link (link)                            ║
║                                        ├──► vehicle_telemetry_history (cold, last 24h)           ║
║                                        └──► meter_telemetry_history (cold, last 24h)             ║
║                                                                                                  ║
║  Total tables: 33 (2 partitioned parents + 26 monthly partitions + 2 defaults                    ║
║                     + 2 hot store + 1 link + 2 rollups + 1 materialized view)                    ║
╚══════════════════════════════════════════════════════════════════════════════════════════════════╝
```

### Why this architecture?

Every design decision traces back to one constraint: **28 million writes per day cannot coexist with analytical reads on the same data structures without one destroying the other's performance.** The separation into hot store, cold store, and rollups ensures that writers never block readers and readers never scan raw write-optimized tables.

### Technology choices

| Choice | Reasoning |
|---|---|
| **NestJS + Fastify** | Fastify delivers 2-3x higher JSON throughput than Express. NestJS provides structure for a production codebase without sacrificing performance. |
| **TypeORM with raw SQL** | TypeORM manages connections and entities. All hot-path queries (ingestion, analytics) use raw parameterized SQL for predictable `EXPLAIN` plans and zero ORM overhead. |
| **PgBouncer** | Transaction-mode connection pooling. 10 app replicas (200 client connections) multiplex into 40 actual Postgres connections. Without this, Postgres collapses at ~500 connections. |
| **PostgreSQL (no TimescaleDB)** | Native declarative partitioning + BRIN indexes handle our scale without adding an extension dependency. One fewer thing to upgrade, patch, and debug in production. |

---

## Data Flow

### Write path (ingestion)

1. Device sends telemetry via `POST /v1/telemetry`
2. Payload is validated against the correct DTO (`VehiclePayloadDto` or `MeterPayloadDto`)
3. Record is pushed into the **in-memory write buffer** (not directly to the database)
4. Buffer flushes when it reaches 500 records OR every 2 seconds (whichever comes first)
5. Each flush executes a single transaction containing:
   - Multi-row `INSERT INTO history_table VALUES (...), (...), (...)` — **cold store**
   - Multi-row `INSERT ... ON CONFLICT DO UPDATE` — **hot store**
6. HTTP response returns `202 Accepted` immediately (record is buffered, not yet persisted)

### Why buffer?

Without buffering: 20,000 devices x 1 msg/min = **333 individual INSERT round-trips per second.**

With buffering: 333 records accumulate over ~1.5 seconds, flush as **1 batch INSERT** containing 333-500 rows. That is a **333x reduction** in database round-trips.

### Read path (analytics)

Every read endpoint is designed to avoid touching the raw history tables:

| Query Type | Data Source | Rows Scanned |
|---|---|---|
| "What is vehicle X doing now?" | `vehicle_current_status` (hot) | 1 row (PK lookup) |
| "Last 24h dashboard" | `vehicle_hourly_stats` (rollup) | ~24 rows |
| "Fleet summary for date range" | `*_hourly_stats` (rollup) | ~240K rows max |
| "Historical readings for device X" | `*_telemetry_history` (cold) | ~1440 rows (index scan within 1-2 partitions) |
| "Vehicle charging efficiency" | CTE across cold + link table | ~2880 rows (2 index scans) |

---

## Hot vs Cold Storage

This system maintains **two representations of the same data** optimized for fundamentally different access patterns.

### Cold store (history tables)

```
vehicle_telemetry_history    — partitioned by month
meter_telemetry_history      — partitioned by month
```

- **Operation:** INSERT-ONLY. No updates, no deletes (during normal operation).
- **Growth:** ~28M rows/day, ~840M rows/month.
- **Purpose:** Complete audit trail. "What did device X report at 3:47 AM last Tuesday?"
- **Optimized for:** Sequential append writes + time-range reads with device filter.
- **Retention:** 90 days in Postgres, then archived to cold storage (S3/Parquet).

### Hot store (current status tables)

```
vehicle_current_status    — one row per vehicle (~10K rows total)
meter_current_status      — one row per meter (~10K rows total)
```

- **Operation:** UPSERT. Each incoming reading overwrites the previous one for that device.
- **Size:** Fixed at ~20K rows regardless of time. Fits entirely in Postgres `shared_buffers`.
- **Purpose:** Real-time dashboard. "What is the current state of all vehicles?"
- **Optimized for:** Point lookups and full-table scans (both are sub-millisecond at 20K rows).

### Why separate them?

A single table serving both "latest state" and "historical lookup" is a common anti-pattern at this scale:

- **Indexing conflict:** The history table needs a composite index on `(device_id, timestamp)` for range queries. The live-state table needs only a primary key on `device_id`. Combining them means every query pays for indexes it does not use.
- **Write amplification:** An UPDATE on a billion-row table triggers index maintenance on every index. An INSERT into a partitioned append-only table touches only the active partition's indexes.
- **Vacuum pressure:** Postgres MVCC means UPDATE creates a dead tuple that must be vacuumed. At 20K upserts/minute on a billion-row table, autovacuum can not keep up. On a 20K-row dedicated table, vacuum completes in milliseconds.
- **Lock contention:** Heavy writes on a table that analytics is trying to scan creates lock contention. Separation eliminates this entirely — writers and readers never touch the same table.

---

## Insert vs Upsert Strategy

### History tables: INSERT-ONLY

```sql
INSERT INTO vehicle_telemetry_history
  (vehicle_id, soc, kwh_delivered_dc, battery_temp, recorded_at)
VALUES ($1, $2, $3, $4, $5), ($6, $7, $8, $9, $10), ...
```

No `ON CONFLICT`. No `UPDATE`. Every reading is appended as a new row. This is the fastest possible write pattern for Postgres:
- No index lookup to check for conflicts.
- No dead tuples created (nothing is overwritten).
- WAL logging is minimal (no before-image needed).
- The active partition's B-tree index grows in-order (timestamps are monotonically increasing), so index page splits are rare.

### Current status tables: UPSERT with staleness guard

```sql
INSERT INTO vehicle_current_status
  (vehicle_id, soc, kwh_delivered_dc, battery_temp, last_seen_at, updated_at)
VALUES ($1, $2, $3, $4, $5, NOW())
ON CONFLICT (vehicle_id) DO UPDATE SET
  soc              = EXCLUDED.soc,
  kwh_delivered_dc = EXCLUDED.kwh_delivered_dc,
  battery_temp     = EXCLUDED.battery_temp,
  last_seen_at     = EXCLUDED.last_seen_at,
  updated_at       = NOW()
WHERE vehicle_current_status.last_seen_at < EXCLUDED.last_seen_at;
```

The `WHERE` clause is the critical detail. Messages can arrive out of order (network jitter, retries, multi-threaded ingestion). Without the staleness guard, a delayed old reading would overwrite a newer one. The guard ensures only the **most recent** reading wins, regardless of arrival order.

---

## Index Strategy

Indexes are the difference between a 3ms query and a 30-second full table scan. Every index in this system exists for a specific query pattern, and no index exists without one.

### Cold store indexes

| Index | Type | Serves |
|---|---|---|
| `(vehicle_id, recorded_at DESC)` | B-tree composite | "Readings for vehicle X in time range Y, newest first" |
| `(meter_id, recorded_at DESC)` | B-tree composite | Same for meters |
| `(recorded_at)` | BRIN | Broad time-range scans ("all readings in last 24h") |
| `(ingested_at)` | BRIN | Pipeline lag monitoring ("how far behind is ingestion?") |

**Why DESC on recorded_at?** Analytics queries almost always `ORDER BY recorded_at DESC LIMIT N` (newest first). A DESC index serves this directly. Postgres *can* do a backward scan on an ASC index, but the optimizer sometimes chooses a less efficient plan.

**Why BRIN instead of B-tree for the time column?**

BRIN (Block Range Index) stores min/max values per block range instead of indexing every row. For time-series data where rows are physically ordered by time:

- B-tree on `recorded_at` across 28M rows/day: **~2GB/month**
- BRIN on the same column: **~100KB**
- Write overhead: B-tree must update on every insert. BRIN is nearly zero-cost.

BRIN works because telemetry data arrives in roughly chronological order, so physical row position correlates with timestamp value. If you backfill historical data out of order, BRIN loses its effectiveness — use a staging table for backfills.

### Hot store indexes

**Primary key only.** At 20K rows, any additional index is pure overhead. A sequential scan of the entire hot table takes <1ms.

### Rollup table indexes

| Index | Serves |
|---|---|
| `PRIMARY KEY (device_id, hour_bucket)` | Per-device hourly lookup |
| `(hour_bucket)` | Dashboard "last 24 hours" queries across all devices |

---

## Partitioning Strategy

### Method

PostgreSQL declarative range partitioning on `recorded_at`, with **monthly** granularity.

### Layout

```
vehicle_telemetry_history
  ├── vehicle_telemetry_history_2026_01     (January)
  ├── vehicle_telemetry_history_2026_02     (February — current)
  ├── ...
  ├── vehicle_telemetry_history_2026_12     (December)
  └── vehicle_telemetry_history_default     (catch-all safety net)
```

### Why monthly (not daily)?

| Factor | Daily (365/year) | Monthly (12/year) |
|---|---|---|
| Planner overhead | Evaluates 365 child tables per query | Evaluates 12 child tables per query |
| Rows per partition | ~28M | ~840M |
| Management complexity | 365 partitions to create/archive/monitor | 12 partitions |
| Pruning effectiveness | Excellent for single-day queries | Good — 24h query touches 1-2 partitions |

Monthly is the sweet spot: enough pruning to eliminate >80% of data on time-range queries, few enough partitions to keep the planner fast.

### Why partition at all?

1. **Partition pruning:** A query with `WHERE recorded_at >= NOW() - INTERVAL '24 hours'` automatically skips all partitions that cannot contain matching rows. On a 12-partition layout, that is 10 partitions eliminated without opening them.

2. **Instant retention:** Dropping old data is `ALTER TABLE ... DETACH PARTITION CONCURRENTLY` followed by `DROP TABLE`. This is O(1). Without partitioning, deleting 840M rows from a single table generates massive WAL, blocks autovacuum, and can take hours.

3. **Independent maintenance:** Each partition is vacuumed, analyzed, and indexed independently. The active write partition gets frequent vacuum. Older partitions stabilize and rarely need maintenance.

4. **Parallel scans:** Postgres can scan multiple partitions in parallel for fleet-wide analytics queries.

---

## How Analytics Avoids Full Scans

A full table scan on 840M rows (one month's partition) takes minutes. Every analytics endpoint is designed to avoid this through a defense-in-depth strategy.

### Layer 1: Never query raw history for dashboards

Dashboard endpoints (`/v1/analytics/last-24h`, `/v1/analytics/fleet-summary`) read from **rollup tables** that contain pre-aggregated hourly stats. A 24-hour fleet dashboard scans ~240K rollup rows (10K devices x 24 hours) instead of ~28M raw rows.

### Layer 2: Mandatory time range on history queries

The `/v1/analytics/history` endpoint requires `from` and `to` parameters. The application layer rejects queries without a time range. This ensures partition pruning always activates.

### Layer 3: Partition pruning

With a time range, Postgres eliminates partitions that cannot contain matching rows. A "last 24 hours" query on a 12-month layout touches 1-2 partitions — the other 10 are never opened.

### Layer 4: Composite index scan

Within the surviving partition(s), the composite B-tree index `(device_id, recorded_at DESC)` serves device-specific queries as an index scan. For a single vehicle's last 24 hours: ~1440 rows fetched via index seek. The other 840M rows in the partition are untouched.

### Layer 5: BRIN pre-filtering

For broad time-range scans (all devices in last 24 hours), BRIN eliminates block ranges within the partition that fall outside the time window, reducing the heap blocks that need to be read.

### Result: query performance by endpoint

| Endpoint | Expected Latency | Rows Touched |
|---|---|---|
| `GET /v1/analytics/live/:type/:id` | <1ms | 1 (PK lookup on 20K-row table) |
| `GET /v1/analytics/last-24h/:type` | 5-20ms | ~240K (rollup table) |
| `GET /v1/analytics/fleet-summary` | 10-50ms | ~240K (rollup table) |
| `GET /v1/analytics/history` | 2-8ms | ~1440 (index scan, 1-2 partitions) |
| `GET /v1/analytics/performance/:id` | 3-8ms | ~2880 (two index scans via CTEs) |

---

## Scalability

### The math

```
10,000 smart meters × 1 reading/min × 60 min × 24 hrs = 14.4M meter readings/day
10,000 EV vehicles  × 1 reading/min × 60 min × 24 hrs = 14.4M vehicle readings/day
                                                Total  = 28.8M records/day
```

Sustained rate: **~333 inserts/second.** Burst (all devices sync simultaneously): **~2,000/second.**

### How the system handles this

| Layer | Mechanism | Effect |
|---|---|---|
| **Ingestion buffer** | Batches 500 records before flushing | 333 round-trips/sec → <1 round-trip/sec |
| **Multi-row INSERT** | Single SQL statement for 500 rows | 1 parse + 1 plan + 1 execute (not 500) |
| **Minimal cold-store indexes** | Only composite B-tree + BRIN | Fewer indexes = faster inserts |
| **PgBouncer** | Transaction pooling (40 server connections) | 10 app replicas share 40 PG connections |
| **Monthly partitions** | Active writes hit only the current partition | Index maintenance scoped to ~840M rows, not billions |

### Horizontal scaling path

```
Phase 1 (current):  Single Postgres + PgBouncer + 3 NestJS replicas
                    Handles: 28M records/day (~333/sec sustained)

Phase 2:            Add read replicas for analytics
                    Route /analytics/* to replica, /telemetry to primary
                    Handles: 28M writes/day + unlimited read throughput

Phase 3:            Citus extension for distributed Postgres
                    Shard history tables by device_id across nodes
                    Handles: 280M+ records/day
```

### Handling traffic spikes

| Scenario | Defense |
|---|---|
| All 20K devices sync at once | Write buffer absorbs burst; flushes at steady rate |
| Sustained 5x traffic increase | Scale NestJS replicas: `docker compose up --scale app=10`. PgBouncer absorbs the connection increase. |
| Database falling behind | Monitor `GET /v1/telemetry/buffer-status`. If buffer depth grows, increase `BUFFER_FLUSH_SIZE` or add PG connections. |
| Analytics query during spike | Analytics reads rollup tables (tiny), not the write-hot history partitions. Zero contention. |

---

## API Documentation

### Ingestion

#### `POST /v1/telemetry`

Polymorphic ingestion endpoint. Accepts both meter and vehicle telemetry.

**Request (Vehicle):**
```json
{
  "type": "VEHICLE",
  "payload": {
    "vehicleId": "V001",
    "soc": 72.50,
    "kwhDeliveredDc": 3.2100,
    "batteryTemp": 31.40,
    "timestamp": "2026-02-12T10:30:00Z"
  }
}
```

**Request (Meter):**
```json
{
  "type": "METER",
  "payload": {
    "meterId": "M042",
    "kwhConsumedAc": 4.1500,
    "voltage": 232.10,
    "timestamp": "2026-02-12T10:30:00Z"
  }
}
```

**Response:** `202 Accepted`
```json
{ "accepted": true }
```

The 202 status indicates the record is **buffered, not yet persisted**. It will be flushed to the database within 2 seconds.

#### `GET /v1/telemetry/buffer-status`

Operational monitoring endpoint. Returns current buffer depth.

```json
{ "vehicles": 142, "meters": 87 }
```

If these numbers keep growing, the database is falling behind. Investigate PG connection saturation or slow queries.

### Analytics

#### `GET /v1/analytics/live/:deviceType/:deviceId`

Current state from hot store. Sub-millisecond.

```
GET /v1/analytics/live/VEHICLE/V001
```

#### `GET /v1/analytics/history`

Historical readings from cold store. **Time range required.**

```
GET /v1/analytics/history?deviceType=VEHICLE&deviceId=V001&from=2026-02-11T00:00:00Z&to=2026-02-12T00:00:00Z&limit=100
```

#### `GET /v1/analytics/fleet-summary`

Fleet-level aggregated metrics from rollup tables.

```
GET /v1/analytics/fleet-summary?deviceType=VEHICLE&from=2026-02-11T00:00:00Z&to=2026-02-12T00:00:00Z
```

**Response:**
```json
[
  {
    "hour": "2026-02-12T09:00:00Z",
    "active_vehicles": 8742,
    "fleet_avg_soc": 64.21,
    "fleet_total_kwh_dc": 42850.12,
    "fleet_max_battery_temp": 44.20,
    "total_readings": 524520
  }
]
```

#### `GET /v1/analytics/last-24h/:deviceType`

Dashboard endpoint. Hourly breakdown for the last 24 hours.

```
GET /v1/analytics/last-24h/VEHICLE
```

#### `GET /v1/analytics/performance/:vehicleId`

24-hour charging efficiency for a single vehicle. Joins vehicle DC delivery with meter AC consumption.

```
GET /v1/analytics/performance/V001
```

**Response:**
```json
{
  "vehicleId": "V001",
  "meterId": "M042",
  "totalAcConsumed": 85.50,
  "totalDcDelivered": 76.32,
  "efficiencyRatio": 89.26,
  "averageBatteryTemp": 32.50
}
```

---

## Running with Docker

### Prerequisites

- Docker Engine 24+
- Docker Compose v2

### Quick start (development)

```bash
# 1. Clone and configure
cp .env.example .env

# 2. Build and start all services
docker compose up --build -d

# 3. Verify all containers are running
docker compose ps

# 4. Open Swagger UI in browser
#    http://localhost:3000/api

# 5. Quick health check via terminal
curl http://localhost:3000/v1/telemetry/buffer-status
```

This starts:
- **postgres:5432** — PostgreSQL 16 with tuned config, schema auto-applied on first boot
- **pgbouncer:6432** — Connection pooler (transaction mode, 40 server connections)
- **app:3000** — NestJS application with Swagger UI at `/api`

### Useful commands

```bash
docker compose ps                # Check container status
docker compose logs app -f       # Follow app logs
docker compose logs postgres -f  # Follow DB logs
docker compose down              # Stop all services
docker compose down -v           # Stop and wipe DB data
docker compose up --build -d     # Rebuild after code changes
```

### Connect to the database

```bash
# Via psql (through PgBouncer)
psql -h localhost -p 6432 -U postgres -d energy_db

# Direct to Postgres (bypassing PgBouncer)
psql -h localhost -p 5433 -U postgres -d energy_db
```

### Production deployment

```bash
# Use the production override (3 replicas, log rotation, stricter limits)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d

# Scale app replicas
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale app=5

# Monitor PgBouncer pool utilization
docker exec energy_pgbouncer psql -p 6432 -U postgres pgbouncer -c "SHOW POOLS;"
```

### Service architecture in Docker

```
  HTTP :3000 ──► app (NestJS) ×3 ──► pgbouncer:6432 ──► postgres:5432
                 20 pool each         40 server pool     max_conn=120
                 = 60 client conn     = 40 actual PG connections
```

### Resource requirements

| Service | CPU | Memory | Storage |
|---|---|---|---|
| postgres | 2-4 cores | 16-32 GB | SSD, ~50GB/month growth |
| pgbouncer | 0.5 cores | 512 MB | — |
| app (per replica) | 1-2 cores | 1-2 GB | — |

---

## Project Structure

```
energy-ingestion-engine/
├── database/
│   └── schema.sql                       # Complete PG schema (tables, indexes, partitions, matviews)
├── docker/
│   ├── postgres/
│   │   ├── postgresql.conf              # Tuned PG config (32GB baseline)
│   │   └── init.sh                      # Auto-applies schema on first boot
│   └── pgbouncer/
│       ├── pgbouncer.ini                # Transaction pooling config
│       └── userlist.txt                 # PgBouncer auth
├── src/
│   ├── main.ts                          # Fastify bootstrap, global pipes/filters
│   ├── app.module.ts                    # Root module
│   ├── config/
│   │   └── database.config.ts           # TypeORM + PgBouncer-compatible pool config
│   ├── common/
│   │   └── filters/
│   │       └── all-exceptions.filter.ts # Global error handler
│   ├── telemetry/                       # ── WRITE PATH ──
│   │   ├── telemetry.module.ts
│   │   ├── telemetry.controller.ts      # POST /v1/telemetry
│   │   ├── telemetry.service.ts         # Polymorphic dispatch + DTO validation
│   │   ├── ingestion-buffer.service.ts  # In-memory batch buffer
│   │   ├── dto/
│   │   │   └── ingest-telemetry.dto.ts  # class-validator DTOs
│   │   ├── entities/                    # TypeORM entity definitions
│   │   └── repositories/               # Raw SQL batch INSERT + UPSERT
│   └── analytics/                       # ── READ PATH ──
│       ├── analytics.module.ts
│       ├── analytics.controller.ts      # 5 GET endpoints
│       ├── analytics.service.ts         # Raw SQL against rollups + hot store
│       └── dto/
│           └── analytics-query.dto.ts
├── Dockerfile                           # Multi-stage build (~180MB image)
├── docker-compose.yml                   # Dev stack
├── docker-compose.prod.yml              # Prod override (replicas, log rotation)
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Future Improvements

### Short-term (production hardening)

- **pg_cron for rollup jobs.** The hourly stats tables need a scheduled job to aggregate from raw history. Currently designed for but not yet automated. pg_cron running `INSERT INTO vehicle_hourly_stats SELECT ... FROM vehicle_telemetry_history WHERE recorded_at >= date_trunc('hour', NOW() - INTERVAL '1 hour')` every 15 minutes.
- **Materialized view refresh.** `mv_vehicle_performance_24h` is defined in the schema but needs a pg_cron job for `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- **Grafana dashboards.** The buffer-status endpoint and PgBouncer `SHOW STATS` provide the metrics. Wire them to Grafana for real-time visibility.
- **Rate limiting.** Per-device rate limiting at the ingestion endpoint to prevent a misbehaving device from flooding the buffer.

### Medium-term (scale)

- **Read replicas.** Route all `/v1/analytics/*` traffic to a streaming replica. Zero analytics load on the primary.
- **MQTT ingestion.** Replace HTTP polling with MQTT pub/sub for lower overhead and push-based delivery. NestJS supports this via `@nestjs/microservices`.
- **Covering indexes.** Add `INCLUDE (kwh_delivered_dc, battery_temp)` to the composite index for true index-only scans (no heap fetches) on performance queries.
- **Connection-level prepared statements.** The ingestion and performance queries are hot-path. Preparing them once per connection skips repeated parse/plan overhead (requires PgBouncer 1.21+ with `prepared_statement_count`).

### Long-term (100K+ devices)

- **Citus distributed Postgres.** Shard the history tables by `device_id` across multiple nodes. The schema, indexes, and partitioning strategy transfer directly — Citus supports declarative partitioning on distributed tables.
- **ClickHouse or TimescaleDB for analytics.** If analytical query complexity grows (percentiles, window functions, cross-device correlation), a columnar store provides 10-100x faster analytical scans. The ingestion engine would dual-write to both PG (live state) and the analytical store (historical).
- **Event streaming (Kafka).** Replace the in-memory buffer with Kafka topics for durability guarantees, replay capability, and multi-consumer fan-out (analytics, alerting, ML pipelines).
