import { Body, Controller, Get, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "./current-user.decorator";
import { parseBody } from "../common/zod";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";

const requestOtpSchema = z.object({ email: z.email() });
const verifyOtpSchema = z.object({ email: z.email(), code: z.string().length(6) });
const refreshSchema = z.object({ refreshToken: z.string().min(32) });

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Spec §22 — POST /auth/otp/request
  @Public()
  @Post("otp/request")
  requestOtp(@Body() body: unknown) {
    const { email } = parseBody(requestOtpSchema, body);
    return this.auth.requestOtp(email);
  }

  // Spec §22 — POST /auth/otp/verify
  @Public()
  @Post("otp/verify")
  verifyOtp(@Body() body: unknown) {
    const { email, code } = parseBody(verifyOtpSchema, body);
    return this.auth.verifyOtp(email, code);
  }

  @Public()
  @Post("refresh")
  refresh(@Body() body: unknown) {
    const { refreshToken } = parseBody(refreshSchema, body);
    return this.auth.refresh(refreshToken);
  }

  @Public()
  @Post("logout")
  logout(@Body() body: unknown) {
    const { refreshToken } = parseBody(refreshSchema, body);
    return this.auth.logout(refreshToken);
  }

  @Get("session")
  session(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.getSession(user.id);
  }
}
