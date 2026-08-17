import { Body, Controller, Get, Param, Patch, Post } from "@nestjs/common";
import { z } from "zod";
import { CurrentUser, type AuthenticatedUser } from "../auth/current-user.decorator";
import { parseBody } from "../common/zod";
import { WorkersService } from "./workers.service";

const solanaAddress = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
const addWalletSchema = z.object({
  address: solanaAddress,
  walletType: z.enum(["EXTERNAL", "EMBEDDED"]).optional(),
});

@Controller("workers/me")
export class WorkersController {
  constructor(private readonly workers: WorkersService) {}

  @Get()
  me(@CurrentUser() user: AuthenticatedUser) {
    return this.workers.getMe(user.id);
  }

  @Get("venue-connections")
  venueConnections(@CurrentUser() user: AuthenticatedUser) {
    return this.workers.venueConnections(user.id);
  }

  @Get("tax-readiness")
  taxReadiness(@CurrentUser() user: AuthenticatedUser) {
    return this.workers.taxReadiness(user.id);
  }

  @Post("wallets")
  addWallet(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    return this.workers.addWallet(user.id, parseBody(addWalletSchema, body));
  }

  @Patch("wallets/:id/default")
  setDefault(@CurrentUser() user: AuthenticatedUser, @Param("id") walletId: string) {
    return this.workers.setDefaultWallet(user.id, walletId);
  }
}
