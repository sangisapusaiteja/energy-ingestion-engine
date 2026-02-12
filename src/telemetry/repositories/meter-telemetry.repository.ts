import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MeterPayloadDto } from '../dto/ingest-telemetry.dto';

@Injectable()
export class MeterTelemetryRepository {
  private readonly logger = new Logger(MeterTelemetryRepository.name);

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Bulk insert into meter_telemetry_history (cold store)
   * + Upsert into meter_current_status (hot store)
   * within a single transaction.
   */
  async ingestBatch(records: MeterPayloadDto[]): Promise<void> {
    if (records.length === 0) return;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // ── 1. Bulk INSERT into cold store (append-only) ──────────────

      const historyValues: unknown[] = [];
      const historyPlaceholders: string[] = [];

      for (let i = 0; i < records.length; i++) {
        const offset = i * 4;
        historyPlaceholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`,
        );
        historyValues.push(
          records[i].meterId,
          records[i].kwhConsumedAc,
          records[i].voltage,
          new Date(records[i].timestamp),
        );
      }

      await queryRunner.query(
        `INSERT INTO meter_telemetry_history
           (meter_id, kwh_consumed_ac, voltage, recorded_at)
         VALUES ${historyPlaceholders.join(', ')}`,
        historyValues,
      );

      // ── 2. UPSERT into hot store (latest state per meter) ────────

      const upsertValues: unknown[] = [];
      const upsertPlaceholders: string[] = [];

      for (let i = 0; i < records.length; i++) {
        const offset = i * 4;
        upsertPlaceholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, NOW())`,
        );
        upsertValues.push(
          records[i].meterId,
          records[i].kwhConsumedAc,
          records[i].voltage,
          new Date(records[i].timestamp),
        );
      }

      await queryRunner.query(
        `INSERT INTO meter_current_status
           (meter_id, kwh_consumed_ac, voltage, last_seen_at, updated_at)
         VALUES ${upsertPlaceholders.join(', ')}
         ON CONFLICT (meter_id) DO UPDATE SET
           kwh_consumed_ac = EXCLUDED.kwh_consumed_ac,
           voltage         = EXCLUDED.voltage,
           last_seen_at    = EXCLUDED.last_seen_at,
           updated_at      = NOW()
         WHERE meter_current_status.last_seen_at < EXCLUDED.last_seen_at`,
        upsertValues,
      );

      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      this.logger.error(
        `Meter batch ingest failed (${records.length} records)`,
        error instanceof Error ? error.stack : String(error),
      );
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
