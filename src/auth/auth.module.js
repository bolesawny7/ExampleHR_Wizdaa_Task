import { Global, Module } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '../config/config.service.js';
import { JwtAuthGuard } from './auth.guard.js';
import { JwtService } from './jwt.service.js';

@Global()
@Module({
  providers: [
    {
      provide: JwtService,
      useFactory: (config) => new JwtService(config),
      inject: [ConfigService],
    },
    {
      provide: JwtAuthGuard,
      useFactory: (reflector, jwt) => new JwtAuthGuard(reflector, jwt),
      inject: [Reflector, JwtService],
    },
  ],
  exports: [JwtService, JwtAuthGuard],
})
export class AuthModule {}
