import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { VehiclePayloadDto, MeterPayloadDto } from './dto/ingest-telemetry.dto';
import { VehicleTelemetryRepository } from './repositories/vehicle-telemetry.repository';
import { MeterTelemetryRepository } from './repositories/meter-telemetry.repository';

/**
 * In-memory write buffer that batches telemetry records before flushing to PG.
 *
 * Why buffer?
 * - 20,000 devices x 1 msg/min = 333 inserts/sec sustained
 * - Individual INSERTs = 333 round-trips/sec
 * - Batched INSERTs (500 per flush) = <1 round-trip/sec
 *
 * Flush triggers:
 * 1. Buffer reaches FLUSH_SIZE (configurable, default 500)
 * 2. Timer fires every FLUSH_INTERVAL_MS (configurable, default 2000ms)
 * Whichever comes first.
 */
@Injectable()
export class IngestionBufferService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IngestionBufferService.name);

  private vehicleBuffer: VehiclePayloadDto[] = [];
  private meterBuffer: MeterPayloadDto[] = [];
  private flushTimer: NodeJS.Timeout | null = null;

  private readonly FLUSH_SIZE: number;
  private readonly FLUSH_INTERVAL_MS: number;

  constructor(
    private readonly vehicleRepo: VehicleTelemetryRepository,
    private readonly meterRepo: MeterTelemetryRepository,
  ) {
    this.FLUSH_SIZE = parseInt(process.env.BUFFER_FLUSH_SIZE ?? '500', 10);
    this.FLUSH_INTERVAL_MS = parseInt(
      process.env.BUFFER_FLUSH_INTERVAL_MS ?? '2000',
      10,
    );
  }

  onModuleInit() {
    this.startFlushTimer();
    this.logger.log(
      `Ingestion buffer started (flush: ${this.FLUSH_SIZE} records or ${this.FLUSH_INTERVAL_MS}ms)`,
    );
  }

  async onModuleDestroy() {
    // Drain remaining records on shutdown
    this.stopFlushTimer();
    await this.flushAll();
    this.logger.log('Ingestion buffer drained on shutdown');
  }

  pushVehicle(record: VehiclePayloadDto): void {
    this.vehicleBuffer.push(record);
    if (this.vehicleBuffer.length >= this.FLUSH_SIZE) {
      void this.flushVehicles();
    }
  }

  pushMeter(record: MeterPayloadDto): void {
    this.meterBuffer.push(record);
    if (this.meterBuffer.length >= this.FLUSH_SIZE) {
      void this.flushMeters();
    }
  }

  getBufferDepth(): { vehicles: number; meters: number } {
    return {
      vehicles: this.vehicleBuffer.length,
      meters: this.meterBuffer.length,
    };
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private startFlushTimer(): void {
    this.flushTimer = setInterval(() => {
      void this.flushAll();
    }, this.FLUSH_INTERVAL_MS);
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async flushAll(): Promise<void> {
    await Promise.all([this.flushVehicles(), this.flushMeters()]);
  }

  private async flushVehicles(): Promise<void> {
    if (this.vehicleBuffer.length === 0) return;

    // Swap buffer — allows new records to accumulate while flushing
    const batch = this.vehicleBuffer;
    this.vehicleBuffer = [];

    try {
      await this.vehicleRepo.ingestBatch(batch);
      this.logger.debug(`Flushed ${batch.length} vehicle records`);
    } catch (error) {
      // Re-enqueue failed records at the front for retry on next flush
      this.vehicleBuffer = batch.concat(this.vehicleBuffer);
      this.logger.error(
        `Vehicle flush failed, ${batch.length} records re-queued`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async flushMeters(): Promise<void> {
    if (this.meterBuffer.length === 0) return;

    const batch = this.meterBuffer;
    this.meterBuffer = [];

    try {
      await this.meterRepo.ingestBatch(batch);
      this.logger.debug(`Flushed ${batch.length} meter records`);
    } catch (error) {
      this.meterBuffer = batch.concat(this.meterBuffer);
      this.logger.error(
        `Meter flush failed, ${batch.length} records re-queued`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
