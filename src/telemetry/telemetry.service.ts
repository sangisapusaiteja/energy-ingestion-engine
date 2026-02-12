import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  IngestTelemetryDto,
  TelemetryType,
  VehiclePayloadDto,
  MeterPayloadDto,
} from './dto/ingest-telemetry.dto';
import { IngestionBufferService } from './ingestion-buffer.service';

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(private readonly buffer: IngestionBufferService) {}

  /**
   * Polymorphic ingestion entry point.
   * Validates the payload against the correct DTO based on `type`,
   * then pushes to the in-memory buffer for batched persistence.
   */
  async ingest(dto: IngestTelemetryDto): Promise<{ accepted: boolean }> {
    switch (dto.type) {
      case TelemetryType.VEHICLE:
        await this.ingestVehicle(dto.payload);
        break;
      case TelemetryType.METER:
        await this.ingestMeter(dto.payload);
        break;
      default:
        throw new BadRequestException(
          `Unknown telemetry type: ${dto.type}. Expected METER or VEHICLE.`,
        );
    }

    return { accepted: true };
  }

  getBufferStatus(): { vehicles: number; meters: number } {
    return this.buffer.getBufferDepth();
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async ingestVehicle(payload: unknown): Promise<void> {
    const vehicleDto = plainToInstance(VehiclePayloadDto, payload);
    const errors = await validate(vehicleDto);

    if (errors.length > 0) {
      const messages = errors.flatMap((e) =>
        Object.values(e.constraints ?? {}),
      );
      throw new BadRequestException({
        message: 'Invalid VEHICLE payload',
        errors: messages,
      });
    }

    this.buffer.pushVehicle(vehicleDto);
  }

  private async ingestMeter(payload: unknown): Promise<void> {
    const meterDto = plainToInstance(MeterPayloadDto, payload);
    const errors = await validate(meterDto);

    if (errors.length > 0) {
      const messages = errors.flatMap((e) =>
        Object.values(e.constraints ?? {}),
      );
      throw new BadRequestException({
        message: 'Invalid METER payload',
        errors: messages,
      });
    }

    this.buffer.pushMeter(meterDto);
  }
}
