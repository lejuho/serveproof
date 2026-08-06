import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaService } from "./prisma.service";
import { QueueRunnerService } from "./queue-runner.service";
import { SolanaSettlementService } from "./solana-settlement.service";
import { SquareSyncService } from "./square-sync.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ["../../.env", ".env"],
    }),
  ],
  providers: [PrismaService, SolanaSettlementService, SquareSyncService, QueueRunnerService],
})
export class WorkerModule {}
