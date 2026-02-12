import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getDatabaseConfig } from './config/database.config';
import { TelemetryModule } from './telemetry/telemetry.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    TypeOrmModule.forRoot(getDatabaseConfig()),
    TelemetryModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
