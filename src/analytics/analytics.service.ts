import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  DeviceHistoryQueryDto,
  FleetSummaryQueryDto,
  DeviceType,
} from './dto/analytics-query.dto';

/**
 * Analytics service uses RAW SQL exclusively.
 *
 * Why raw SQL instead of TypeORM QueryBuilder?
 * 1. Full control over partition pruning hints
 * 2. No ORM overhead on read-heavy analytical queries
 * 3. Can use PG-specific features (date_trunc, generate_series, etc.)
 * 4. Query plans are predictable and EXPLAIN-able
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(private readonly dataSource: DataSource) {}

  // ─── Device History (Cold Store) ──────────────────────────────────────

  async getDeviceHistory(query: DeviceHistoryQueryDto) {
    const { deviceType, deviceId, from, to, limit } = query;

    if (deviceType === DeviceType.VEHICLE) {
      return this.dataSource.query(
        `SELECT
           vehicle_id,
           soc,
           kwh_delivered_dc,
           battery_temp,
           recorded_at
         FROM vehicle_telemetry_history
         WHERE vehicle_id = $1
           AND recorded_at >= $2
           AND recorded_at < $3
         ORDER BY recorded_at DESC
         LIMIT $4`,
        [deviceId, from, to, limit],
      );
    }

    if (deviceType === DeviceType.METER) {
      return this.dataSource.query(
        `SELECT
           meter_id,
           kwh_consumed_ac,
           voltage,
           recorded_at
         FROM meter_telemetry_history
         WHERE meter_id = $1
           AND recorded_at >= $2
           AND recorded_at < $3
         ORDER BY recorded_at DESC
         LIMIT $4`,
        [deviceId, from, to, limit],
      );
    }

    throw new BadRequestException(`Unknown device type: ${deviceType}`);
  }

  // ─── Live Status (Hot Store) ──────────────────────────────────────────

  async getLiveStatus(deviceType: DeviceType, deviceId: string) {
    if (deviceType === DeviceType.VEHICLE) {
      const rows = await this.dataSource.query(
        `SELECT * FROM vehicle_current_status WHERE vehicle_id = $1`,
        [deviceId],
      );
      return rows[0] ?? null;
    }

    const rows = await this.dataSource.query(
      `SELECT * FROM meter_current_status WHERE meter_id = $1`,
      [deviceId],
    );
    return rows[0] ?? null;
  }

  // ─── Fleet Summary (Rollup Tables) ───────────────────────────────────
  // Hits pre-aggregated hourly stats — never touches raw history.

  async getFleetSummary(query: FleetSummaryQueryDto) {
    const { deviceType, from, to } = query;

    if (deviceType === DeviceType.VEHICLE) {
      return this.dataSource.query(
        `SELECT
           date_trunc('hour', hour_bucket) AS hour,
           COUNT(DISTINCT vehicle_id)       AS active_vehicles,
           ROUND(AVG(avg_soc), 2)           AS fleet_avg_soc,
           ROUND(SUM(total_kwh_dc), 2)      AS fleet_total_kwh_dc,
           ROUND(MAX(max_battery_temp), 2)   AS fleet_max_battery_temp,
           SUM(reading_count)               AS total_readings
         FROM vehicle_hourly_stats
         WHERE hour_bucket >= $1
           AND hour_bucket < $2
         GROUP BY date_trunc('hour', hour_bucket)
         ORDER BY hour DESC`,
        [from, to],
      );
    }

    if (deviceType === DeviceType.METER) {
      return this.dataSource.query(
        `SELECT
           date_trunc('hour', hour_bucket) AS hour,
           COUNT(DISTINCT meter_id)         AS active_meters,
           ROUND(SUM(total_kwh_ac), 2)      AS fleet_total_kwh_ac,
           ROUND(AVG(avg_voltage), 2)        AS fleet_avg_voltage,
           ROUND(MIN(min_voltage), 2)        AS fleet_min_voltage,
           SUM(reading_count)               AS total_readings
         FROM meter_hourly_stats
         WHERE hour_bucket >= $1
           AND hour_bucket < $2
         GROUP BY date_trunc('hour', hour_bucket)
         ORDER BY hour DESC`,
        [from, to],
      );
    }

    throw new BadRequestException(`Unknown device type: ${deviceType}`);
  }

  // ─── 24-Hour Analytics (Optimized) ────────────────────────────────────
  // Specifically tuned for the "last 24h dashboard" use case.
  // Uses the hourly rollup table — ~480K rows max scan.

  async getLast24HoursSummary(deviceType: DeviceType) {
    if (deviceType === DeviceType.VEHICLE) {
      return this.dataSource.query(
        `SELECT
           hour_bucket AS hour,
           COUNT(DISTINCT vehicle_id) AS active_vehicles,
           ROUND(AVG(avg_soc), 2) AS avg_soc,
           ROUND(SUM(total_kwh_dc), 2) AS total_kwh_dc,
           ROUND(MAX(max_battery_temp), 2) AS max_battery_temp
         FROM vehicle_hourly_stats
         WHERE hour_bucket >= NOW() - INTERVAL '24 hours'
         GROUP BY hour_bucket
         ORDER BY hour_bucket DESC`,
      );
    }

    return this.dataSource.query(
      `SELECT
         hour_bucket AS hour,
         COUNT(DISTINCT meter_id) AS active_meters,
         ROUND(SUM(total_kwh_ac), 2) AS total_kwh_ac,
         ROUND(AVG(avg_voltage), 2) AS avg_voltage,
         ROUND(MIN(min_voltage), 2) AS min_voltage
       FROM meter_hourly_stats
       WHERE hour_bucket >= NOW() - INTERVAL '24 hours'
       GROUP BY hour_bucket
       ORDER BY hour_bucket DESC`,
    );
  }

  // ─── Vehicle Performance (24h) ──────────────────────────────────────
  //
  // GET /v1/analytics/performance/:vehicleId
  //
  // This is the most complex query in the system. It joins two partitioned
  // history tables through a tiny link table to compute charger efficiency.
  //
  // ┌────────────────────────────────────────────────────────────────────┐
  // │ QUERY EXECUTION PLAN (conceptual)                                 │
  // │                                                                   │
  // │  1. vehicle_meter_link        → PK lookup on vehicle_id           │
  // │     (~10K rows, cached)         Cost: ~0.01ms                     │
  // │                                                                   │
  // │  2. vehicle_telemetry_history → Partition prune to current month  │
  // │     + idx_vehicle_history_device_time (vehicle_id, recorded_at)   │
  // │     Scans ~1440 rows (1 reading/min × 24h)                       │
  // │     Cost: ~1-3ms (index-only within single partition)             │
  // │                                                                   │
  // │  3. meter_telemetry_history   → Partition prune to current month  │
  // │     + idx_meter_history_device_time (meter_id, recorded_at)       │
  // │     Scans ~1440 rows                                              │
  // │     Cost: ~1-3ms                                                  │
  // │                                                                   │
  // │  4. Aggregate + compute ratio → In-memory, trivial                │
  // │                                                                   │
  // │  Total expected: 2-8ms                                            │
  // └────────────────────────────────────────────────────────────────────┘
  //
  // WHY THIS QUERY IS EFFICIENT:
  //
  // 1. NO full table scan.
  //    - recorded_at >= NOW() - '24 hours' triggers PARTITION PRUNING.
  //      Postgres eliminates all monthly partitions except the current
  //      one (and possibly the previous one if the 24h window crosses
  //      a month boundary). That's 1-2 partitions out of 12+.
  //
  // 2. COMPOSITE INDEX (vehicle_id, recorded_at DESC) on each partition.
  //    Within the pruned partition, Postgres does an Index Scan (not Seq
  //    Scan) on idx_vehicle_history_device_time. It seeks directly to
  //    the rows for this vehicle_id in the last 24h. ~1440 rows touched.
  //
  // 3. BRIN index on recorded_at acts as a secondary filter.
  //    If the partition is large (840M rows/month), BRIN eliminates
  //    block ranges that can't contain rows from the last 24h.
  //    This narrows the heap blocks the B-tree index scan must visit.
  //
  // 4. CTE isolation: vehicle and meter aggregations run independently.
  //    The planner can parallelize the two CTE scans. No nested loops
  //    across history tables — the only join is on the single-row
  //    CTE results.
  //
  // 5. Link table lookup is a PK index scan on ~10K rows. Cached in
  //    shared_buffers after the first call.
  //
  // ─── EXPECTED EXPLAIN ANALYZE OUTPUT ─────────────────────────────────
  //
  //  CTE Scan on vehicle_stats
  //    -> Append (partitions pruned: 10 of 12)
  //       -> Index Scan using vehicle_telemetry_history_2026_02_idx
  //          on vehicle_telemetry_history_2026_02
  //          Index Cond: (vehicle_id = $1 AND recorded_at >= ...)
  //          Rows Removed by Filter: 0
  //          Actual Rows: ~1440
  //          Actual Time: 1.2..2.8ms
  //
  //  CTE Scan on meter_stats
  //    -> Append (partitions pruned: 10 of 12)
  //       -> Index Scan using meter_telemetry_history_2026_02_idx
  //          on meter_telemetry_history_2026_02
  //          Index Cond: (meter_id = $1 AND recorded_at >= ...)
  //          Actual Rows: ~1440
  //          Actual Time: 1.1..2.5ms
  //
  //  Nested Loop (on CTE results — 1 row each)
  //    Actual Time: 0.01ms
  //
  //  Total Runtime: ~3-7ms
  // ─────────────────────────────────────────────────────────────────────

  async getVehiclePerformance(vehicleId: string) {
    // Step 1: Resolve the linked meter for this vehicle.
    // Separate query so we get a clear 404 if the vehicle isn't linked.
    const linkRows = await this.dataSource.query(
      `SELECT meter_id FROM vehicle_meter_link WHERE vehicle_id = $1`,
      [vehicleId],
    );

    if (linkRows.length === 0) {
      throw new NotFoundException(
        `Vehicle "${vehicleId}" not found or has no linked meter`,
      );
    }

    const meterId: string = linkRows[0].meter_id;

    // Step 2: Two independent CTEs — one per history table.
    // Each CTE hits exactly one composite index within 1-2 partitions.
    const rows = await this.dataSource.query(
      `WITH vehicle_stats AS (
          SELECT
              COALESCE(SUM(kwh_delivered_dc), 0) AS total_dc_delivered,
              ROUND(AVG(battery_temp), 2)         AS avg_battery_temp,
              COUNT(*)                            AS vehicle_readings
          FROM vehicle_telemetry_history
          WHERE vehicle_id = $1
            AND recorded_at >= NOW() - INTERVAL '24 hours'
      ),
      meter_stats AS (
          SELECT
              COALESCE(SUM(kwh_consumed_ac), 0)  AS total_ac_consumed,
              COUNT(*)                            AS meter_readings
          FROM meter_telemetry_history
          WHERE meter_id = $2
            AND recorded_at >= NOW() - INTERVAL '24 hours'
      )
      SELECT
          vs.total_dc_delivered   AS "totalDcDelivered",
          ms.total_ac_consumed    AS "totalAcConsumed",
          CASE
              WHEN ms.total_ac_consumed > 0
              THEN ROUND(vs.total_dc_delivered / ms.total_ac_consumed * 100, 2)
              ELSE 0
          END                     AS "efficiencyRatio",
          vs.avg_battery_temp     AS "averageBatteryTemp",
          vs.vehicle_readings     AS "vehicleReadings",
          ms.meter_readings       AS "meterReadings"
      FROM vehicle_stats vs
      CROSS JOIN meter_stats ms`,
      [vehicleId, meterId],
    );

    const result = rows[0];

    this.logger.debug(
      `Performance query for vehicle=${vehicleId} meter=${meterId}: ` +
        `${result.vehicleReadings} vehicle + ${result.meterReadings} meter readings`,
    );

    return {
      vehicleId,
      meterId,
      totalAcConsumed: parseFloat(result.totalAcConsumed),
      totalDcDelivered: parseFloat(result.totalDcDelivered),
      efficiencyRatio: parseFloat(result.efficiencyRatio),
      averageBatteryTemp: parseFloat(result.averageBatteryTemp),
    };
  }
}
