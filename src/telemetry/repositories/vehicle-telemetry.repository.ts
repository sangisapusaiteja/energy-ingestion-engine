import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { VehiclePayloadDto } from '../dto/ingest-telemetry.dto';

@Injectable()
export class VehicleTelemetryRepository {
  private readonly logger = new Logger(VehicleTelemetryRepository.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Bulk insert into vehicle_telemetry_history (cold store)
   * + Upsert into vehicle_current_status (hot store)
   * within a single transaction.
   */
  async ingestBatch(records: VehiclePayloadDto[]): Promise<void> {
    if (records.length === 0) return;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // ── 1. Bulk INSERT into cold store (append-only) ──────────────
      // Build a single multi-row INSERT for maximum throughput.
      // $1, $2, ... parameterized to prevent SQL injection.

      const historyValues: unknown[] = [];
      const historyPlaceholders: string[] = [];

      for (let i = 0; i < records.length; i++) {
        const offset = i * 4;
        historyPlaceholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`,
        );
        historyValues.push(
          records[i].vehicleId,
          records[i].soc,
          records[i].kwhDeliveredDc,
          records[i].batteryTemp,
          // recorded_at is appended below
        );
      }

      // Rebuild with 5 params per row (including timestamp)
      const historyValues5: unknown[] = [];
      const historyPlaceholders5: string[] = [];

      for (let i = 0; i < records.length; i++) {
        const offset = i * 5;
        historyPlaceholders5.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`,
        );
        historyValues5.push(
          records[i].vehicleId,
          records[i].soc,
          records[i].kwhDeliveredDc,
          records[i].batteryTemp,
          new Date(records[i].timestamp),
        );
      }

      await queryRunner.query(
        `INSERT INTO vehicle_telemetry_history
           (vehicle_id, soc, kwh_delivered_dc, battery_temp, recorded_at)
         VALUES ${historyPlaceholders5.join(', ')}`,
        historyValues5,
      );

      // ── 2. UPSERT into hot store (latest state per vehicle) ───────
      // Uses ON CONFLICT with a staleness guard: only update if the
      // incoming reading is newer than what we have.

      const upsertValues: unknown[] = [];
      const upsertPlaceholders: string[] = [];

      for (let i = 0; i < records.length; i++) {
        const offset = i * 5;
        upsertPlaceholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`,
        );
        upsertValues.push(
          records[i].vehicleId,
          records[i].soc,
          records[i].kwhDeliveredDc,
          records[i].batteryTemp,
          new Date(records[i].timestamp),
        );
      }

      await queryRunner.query(
        `INSERT INTO vehicle_current_status
           (vehicle_id, soc, kwh_delivered_dc, battery_temp, last_seen_at, updated_at)
         VALUES ${upsertPlaceholders.map((p) => p.replace(')', ', NOW())')).join(', ')}
         ON CONFLICT (vehicle_id) DO UPDATE SET
           soc              = EXCLUDED.soc,
           kwh_delivered_dc = EXCLUDED.kwh_delivered_dc,
           battery_temp     = EXCLUDED.battery_temp,
           last_seen_at     = EXCLUDED.last_seen_at,
           updated_at       = NOW()
         WHERE vehicle_current_status.last_seen_at < EXCLUDED.last_seen_at`,
        upsertValues,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Vehicle batch ingest failed (${records.length} records)`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
