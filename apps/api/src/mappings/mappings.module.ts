import { Module } from "@nestjs/common";
import { MappingsController } from "./mappings.controller";
import { MappingsService } from "./mappings.service";

@Module({
  controllers: [MappingsController],
  providers: [MappingsService],
})
export class MappingsModule {}
