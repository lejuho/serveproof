import { Module } from "@nestjs/common";
import { StaffingController } from "./staffing.controller";
import { StaffingService } from "./staffing.service";

@Module({
  controllers: [StaffingController],
  providers: [StaffingService],
})
export class StaffingModule {}
