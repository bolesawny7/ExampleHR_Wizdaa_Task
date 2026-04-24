import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { ConfigService } from './config/config.service.js';
import { buildValidationPipe } from './common/validation.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const config = app.get(ConfigService);

  app.use(helmet());
  app.use(express.json({
    // Preserve raw body bytes for HMAC signature verification on HCM webhooks.
    verify: (req, _res, buf) => { req.rawBody = buf; },
    limit: '2mb',
  }));
  app.useGlobalPipes(buildValidationPipe());

  await app.listen(config.port);
  Logger.log(`Time-Off service listening on :${config.port}`, 'Bootstrap');
}

if (require.main === module) {
  bootstrap().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}

export { bootstrap };
