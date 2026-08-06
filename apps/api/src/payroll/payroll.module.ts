import { Module } from "@nestjs/common";
import { IncomeModule } from "../income/income.module";
import { PayrollController } from "./payroll.controller";
import { PayrollService } from "./payroll.service";

@Module({
  imports: [IncomeModule],
  controllers: [PayrollController],
  providers: [PayrollService],
})
export class PayrollModule {}
