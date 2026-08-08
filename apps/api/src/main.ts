import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

// Prisma BigInt columns (amountBaseUnits, slot) must serialize in JSON responses.
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.WEB_ORIGIN ?? "http://localhost:3000" });
  // Railway and similar platforms inject PORT; API_PORT remains the local override.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 3001);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`ServeProof API listening on :${port}`);
}

void bootstrap();
