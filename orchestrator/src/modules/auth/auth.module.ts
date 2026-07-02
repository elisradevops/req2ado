import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AdoPatProvider } from './ado-pat.provider';
import { AuthController } from './auth.controller';
import { AzureAdProvider } from './azure-ad.provider';
import { PrismaService } from './prisma.service';
import { RolesGuard } from './roles.guard';
import { SessionService } from './session.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>('AUTH_JWT_SECRET'),
        signOptions: { expiresIn: '8h' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AzureAdProvider,
    AdoPatProvider,
    PrismaService,
    SessionService,
    Reflector,
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [AzureAdProvider, AdoPatProvider],
})
export class AuthModule {}
