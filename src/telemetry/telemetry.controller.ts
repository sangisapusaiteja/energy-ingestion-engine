import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { TelemetryService } from './telemetry.service';
import { IngestTelemetryDto } from './dto/ingest-telemetry.dto';

@ApiTags('Telemetry')
@Controller('telemetry')
export class TelemetryController {
  constructor(private readonly telemetryService: TelemetryService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Ingest telemetry', description: 'Accepts METER or VEHICLE telemetry. Record is buffered, not yet persisted.' })
  @ApiBody({ type: IngestTelemetryDto })
  @ApiResponse({ status: 202, description: 'Record accepted and buffered' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  async ingest(@Body() dto: IngestTelemetryDto) {
    return this.telemetryService.ingest(dto);
  }

  @Get('buffer-status')
  @ApiOperation({ summary: 'Buffer status', description: 'Monitor buffer depth. If numbers keep growing, the DB is falling behind.' })
  @ApiResponse({ status: 200, description: 'Current buffer depths' })
  getBufferStatus() {
    return this.telemetryService.getBufferStatus();
  }
}
