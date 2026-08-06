import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WorkerModule } from "./worker.module";

/**
 * Background worker process (spec §29.5) — runs BullMQ consumers,
 * separate from the API service.
 */
async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  // eslint-disable-next-line no-console
  console.log("ServeProof worker started");
}

void bootstrap();
