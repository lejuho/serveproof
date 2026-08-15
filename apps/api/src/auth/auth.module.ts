import { Global, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule } from "@nestjs/jwt";
import { AccessService } from "./access.service";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import { MailService } from "./mail.service";

@Global()
@Module({
  imports: [
    JwtModule.register({
      global: true,
      secret: process.env.AUTH_SECRET ?? "dev-only-secret-change-me",
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AccessService, MailService, { provide: APP_GUARD, useClass: JwtAuthGuard }],
  exports: [AccessService, MailService],
})
export class AuthModule {}
