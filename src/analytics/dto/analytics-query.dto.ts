import {
  IsString,
  IsOptional,
  IsDateString,
  IsEnum,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export enum DeviceType {
  METER = 'METER',
  VEHICLE = 'VEHICLE',
}

export class DeviceHistoryQueryDto {
  @ApiProperty({ enum: DeviceType, example: 'VEHICLE' })
  @IsEnum(DeviceType)
  deviceType: DeviceType;

  @ApiProperty({ example: 'V001' })
  @IsString()
  deviceId: string;

  @ApiProperty({ example: '2026-02-11T00:00:00Z' })
  @IsDateString()
  from: string;

  @ApiProperty({ example: '2026-02-12T00:00:00Z' })
  @IsDateString()
  to: string;

  @ApiPropertyOptional({ example: 100, default: 1000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number = 1000;
}

export class FleetSummaryQueryDto {
  @ApiProperty({ enum: DeviceType, example: 'VEHICLE' })
  @IsEnum(DeviceType)
  deviceType: DeviceType;

  @ApiProperty({ example: '2026-02-11T00:00:00Z' })
  @IsDateString()
  from: string;

  @ApiProperty({ example: '2026-02-12T00:00:00Z' })
  @IsDateString()
  to: string;
}
