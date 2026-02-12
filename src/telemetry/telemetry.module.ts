import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';
import { IngestionBufferService } from './ingestion-buffer.service';
import { VehicleTelemetryRepository } from './repositories/vehicle-telemetry.repository';
import { MeterTelemetryRepository } from './repositories/meter-telemetry.repository';
import {
  VehicleTelemetryHistory,
  MeterTelemetryHistory,
  VehicleCurrentStatus,
  MeterCurrentStatus,
} from './entities';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      VehicleTelemetryHistory,
      MeterTelemetryHistory,
      VehicleCurrentStatus,
      MeterCurrentStatus,
    ]),
  ],
  controllers: [TelemetryController],
  providers: [
    TelemetryService,
    IngestionBufferService,
    VehicleTelemetryRepository,
    MeterTelemetryRepository,
  ],
  exports: [TelemetryService],
})
export class TelemetryModule {}
