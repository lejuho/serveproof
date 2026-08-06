import { Module } from "@nestjs/common";
import { PayoutsController } from "./payouts.controller";
import { PayoutsService } from "./payouts.service";

@Module({
  controllers: [PayoutsController],
  providers: [PayoutsService],
})
export class PayoutsModule {}
