import { Module } from "@nestjs/common";
import { AllocationsModule } from "../allocations/allocations.module";
import { EvidenceController } from "./evidence.controller";
import { EvidenceService } from "./evidence.service";

@Module({
  imports: [AllocationsModule],
  controllers: [EvidenceController],
  providers: [EvidenceService],
  exports: [EvidenceService],
})
export class EvidenceModule {}
