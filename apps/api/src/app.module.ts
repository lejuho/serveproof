import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { AllocationsModule } from "./allocations/allocations.module";
import { AuthModule } from "./auth/auth.module";
import { DisclosureModule } from "./disclosure/disclosure.module";
import { EvidenceModule } from "./evidence/evidence.module";
import { HealthModule } from "./health/health.module";
import { IncomeModule } from "./income/income.module";
import { PayrollModule } from "./payroll/payroll.module";
import { MappingsModule } from "./mappings/mappings.module";
import { OrganizationsModule } from "./organizations/organizations.module";
import { PayoutsModule } from "./payouts/payouts.module";
import { PoliciesModule } from "./policies/policies.module";
import { ProvidersModule } from "./providers/providers.module";
import { PrismaModule } from "./prisma/prisma.module";
import { WorkersModule } from "./workers/workers.module";
import { StaffingModule } from "./staffing/staffing.module";
import { PerformanceInterceptor } from "./common/performance.interceptor";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
    }),
    PrismaModule,
    AuthModule,
    HealthModule,
    OrganizationsModule,
    PoliciesModule,
    ProvidersModule,
    WorkersModule,
    EvidenceModule,
    MappingsModule,
    AllocationsModule,
    PayoutsModule,
    IncomeModule,
    PayrollModule,
    DisclosureModule,
    StaffingModule,
  ],
  providers: [{ provide: APP_INTERCEPTOR, useClass: PerformanceInterceptor }],
})
export class AppModule {}
