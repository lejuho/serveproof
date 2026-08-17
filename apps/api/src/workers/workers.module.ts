import { Module } from "@nestjs/common";
import { IncomeModule } from "../income/income.module";
import { WorkersController } from "./workers.controller";
import { WorkersService } from "./workers.service";

@Module({
  imports: [IncomeModule],
  controllers: [WorkersController],
  providers: [WorkersService],
})
export class WorkersModule {}
