import { Body, Controller, Post } from "@nestjs/common";
import { z } from "zod";
import { parseBody } from "../common/zod";
import { AuthService } from "./auth.service";
import { Public } from "./public.decorator";

const requestOtpSchema = z.object({ email: z.email() });
const verifyOtpSchema = z.object({ email: z.email(), code: z.string().length(6) });
const refreshSchema = z.object({ refreshToken: z.string().min(32) });

@Public()
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // Spec §22 — POST /auth/otp/request
  @Post("otp/request")
  requestOtp(@Body() body: unknown) {
    const { email } = parseBody(requestOtpSchema, body);
    return this.auth.requestOtp(email);
  }

  // Spec §22 — POST /auth/otp/verify
  @Post("otp/verify")
  verifyOtp(@Body() body: unknown) {
    const { email, code } = parseBody(verifyOtpSchema, body);
    return this.auth.verifyOtp(email, code);
  }

  @Post("refresh")
  refresh(@Body() body: unknown) {
    const { refreshToken } = parseBody(refreshSchema, body);
    return this.auth.refresh(refreshToken);
  }

  @Post("logout")
  logout(@Body() body: unknown) {
    const { refreshToken } = parseBody(refreshSchema, body);
    return this.auth.logout(refreshToken);
  }
}
