import { Controller, Get, Query, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AnalyticsService } from './analytics.service';
import {
  DeviceHistoryQueryDto,
  FleetSummaryQueryDto,
  DeviceType,
} from './dto/analytics-query.dto';

@ApiTags('Analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('history')
  @ApiOperation({ summary: 'Device history', description: 'Historical readings from cold store. Time range required.' })
  @ApiResponse({ status: 200, description: 'Historical telemetry readings' })
  getDeviceHistory(@Query() query: DeviceHistoryQueryDto) {
    return this.analyticsService.getDeviceHistory(query);
  }

  @Get('live/:deviceType/:deviceId')
  @ApiOperation({ summary: 'Live device status', description: 'Latest known state from hot store. Sub-millisecond.' })
  @ApiParam({ name: 'deviceType', enum: DeviceType })
  @ApiParam({ name: 'deviceId', example: 'V001' })
  @ApiResponse({ status: 200, description: 'Current device state' })
  getLiveStatus(
    @Param('deviceType') deviceType: DeviceType,
    @Param('deviceId') deviceId: string,
  ) {
    return this.analyticsService.getLiveStatus(deviceType, deviceId);
  }

  @Get('fleet-summary')
  @ApiOperation({ summary: 'Fleet summary', description: 'Aggregated fleet-level metrics from rollup tables.' })
  @ApiResponse({ status: 200, description: 'Fleet-level aggregated metrics' })
  getFleetSummary(@Query() query: FleetSummaryQueryDto) {
    return this.analyticsService.getFleetSummary(query);
  }

  @Get('last-24h/:deviceType')
  @ApiOperation({ summary: 'Last 24h dashboard', description: 'Hourly breakdown for the last 24 hours from rollup tables.' })
  @ApiParam({ name: 'deviceType', enum: DeviceType })
  @ApiResponse({ status: 200, description: 'Hourly stats for last 24 hours' })
  getLast24Hours(@Param('deviceType') deviceType: DeviceType) {
    return this.analyticsService.getLast24HoursSummary(deviceType);
  }

  @Get('performance/:vehicleId')
  @ApiOperation({ summary: 'Vehicle charging performance', description: '24h charging efficiency — joins vehicle DC delivery with meter AC consumption.' })
  @ApiParam({ name: 'vehicleId', example: 'V001' })
  @ApiResponse({ status: 200, description: 'Charging efficiency metrics' })
  getVehiclePerformance(@Param('vehicleId') vehicleId: string) {
    return this.analyticsService.getVehiclePerformance(vehicleId);
  }
}
