import { Global, Module } from '@nestjs/common';
import { ConfigService } from './config.service.js';

@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useFactory: () => new ConfigService(),
    },
  ],
  exports: [ConfigService],
})
export class ConfigModule {
  static withOverrides(overrides) {
    return {
      module: ConfigModule,
      global: true,
      providers: [
        {
          provide: ConfigService,
          useValue: new ConfigService(overrides),
        },
      ],
      exports: [ConfigService],
    };
  }
}
