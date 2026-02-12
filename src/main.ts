import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Fastify over Express: 2-3x higher throughput for JSON-heavy ingestion
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 1048576 }), // 1MB — prevents oversized payloads
  );

  app.setGlobalPrefix('v1');

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,            // Strip unknown properties
      forbidNonWhitelisted: true, // Reject unknown properties
      transform: true,            // Auto-transform payloads to DTO instances
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger API documentation
  const config = new DocumentBuilder()
    .setTitle('Energy Ingestion Engine')
    .setDescription('High-scale telemetry ingestion API for smart meters and EV vehicles')
    .setVersion('1.0')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`Energy Ingestion Engine running on port ${port}`);
  logger.log(`Swagger UI available at http://localhost:${port}/api`);
}

bootstrap();
