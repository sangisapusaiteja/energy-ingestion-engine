import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsString,
  IsDateString,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiExtraModels, getSchemaPath } from '@nestjs/swagger';

// ─── Telemetry Type Discriminator ───────────────────────────────────────────

export enum TelemetryType {
  METER = 'METER',
  VEHICLE = 'VEHICLE',
}

// ─── Vehicle Payload ────────────────────────────────────────────────────────

export class VehiclePayloadDto {
  @ApiProperty({ example: 'V001' })
  @IsString()
  @IsNotEmpty()
  vehicleId: string;

  @ApiProperty({ example: 72.5, description: 'State of charge (0-100%)' })
  @IsNumber()
  @Min(0)
  @Max(100)
  soc: number;

  @ApiProperty({ example: 3.21, description: 'DC energy delivered in kWh' })
  @IsNumber()
  @Min(0)
  kwhDeliveredDc: number;

  @ApiProperty({ example: 31.4, description: 'Battery temperature in °C' })
  @IsNumber()
  batteryTemp: number;

  @ApiProperty({ example: '2026-02-12T10:30:00Z' })
  @IsDateString()
  timestamp: string;
}

// ─── Meter Payload ──────────────────────────────────────────────────────────

export class MeterPayloadDto {
  @ApiProperty({ example: 'M042' })
  @IsString()
  @IsNotEmpty()
  meterId: string;

  @ApiProperty({ example: 4.15, description: 'AC energy consumed in kWh' })
  @IsNumber()
  @Min(0)
  kwhConsumedAc: number;

  @ApiProperty({ example: 232.1, description: 'Voltage reading' })
  @IsNumber()
  @Min(0)
  voltage: number;

  @ApiProperty({ example: '2026-02-12T10:30:00Z' })
  @IsDateString()
  timestamp: string;
}

// ─── Polymorphic Ingestion Request ──────────────────────────────────────────
// POST /v1/telemetry
// The controller inspects `type` and validates `payload` against the correct DTO.

export class IngestVehicleTelemetryDto {
  @IsEnum(TelemetryType)
  type: TelemetryType.VEHICLE;

  @ValidateNested()
  @Type(() => VehiclePayloadDto)
  @IsNotEmpty()
  payload: VehiclePayloadDto;
}

export class IngestMeterTelemetryDto {
  @IsEnum(TelemetryType)
  type: TelemetryType.METER;

  @ValidateNested()
  @Type(() => MeterPayloadDto)
  @IsNotEmpty()
  payload: MeterPayloadDto;
}

// ─── Batch Ingestion Request ────────────────────────────────────────────────

@ApiExtraModels(VehiclePayloadDto, MeterPayloadDto)
export class IngestTelemetryDto {
  @ApiProperty({ enum: TelemetryType, example: 'VEHICLE' })
  @IsEnum(TelemetryType)
  type: TelemetryType;

  @ApiProperty({
    description: 'VehiclePayloadDto when type=VEHICLE, MeterPayloadDto when type=METER',
    oneOf: [
      { $ref: getSchemaPath(VehiclePayloadDto) },
      { $ref: getSchemaPath(MeterPayloadDto) },
    ],
  })
  @IsNotEmpty()
  payload: VehiclePayloadDto | MeterPayloadDto;
}
