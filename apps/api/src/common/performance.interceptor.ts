import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { requestPerformance, type RequestPerformanceStore } from "./performance-context";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function prismaErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function responseStatus(response: Response, error: unknown): number {
  if (error && typeof error === "object" && "getStatus" in error) {
    const getStatus = (error as { getStatus?: unknown }).getStatus;
    if (typeof getStatus === "function") {
      const status = getStatus.call(error);
      if (typeof status === "number") return status;
    }
  }
  return error ? 500 : response.statusCode;
}

@Injectable()
export class PerformanceInterceptor implements NestInterceptor {
  private readonly logger = new Logger("ApiPerformance");
  private readonly enabled = process.env.PERFORMANCE_LOGGING_ENABLED !== "false";
  private readonly slowRequestMs = positiveNumber(process.env.API_SLOW_REQUEST_MS, 750);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.enabled || context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const store = requestPerformance.createStore();
    const startedAt = performance.now();
    let finished = false;

    return new Observable((subscriber) =>
      requestPerformance.run(store, () => {
        const finish = (error?: unknown) => {
          if (finished) return;
          finished = true;
          this.logIfNeeded(request, response, store, performance.now() - startedAt, error);
        };
        const subscription = next.handle().subscribe({
          next: (value) => subscriber.next(value),
          error: (error) => {
            finish(error);
            subscriber.error(error);
          },
          complete: () => {
            finish();
            subscriber.complete();
          },
        });
        return () => subscription.unsubscribe();
      }),
    );
  }

  private logIfNeeded(
    request: Request,
    response: Response,
    store: RequestPerformanceStore,
    totalMs: number,
    error?: unknown,
  ): void {
    const errorCode = prismaErrorCode(error);
    const poolTimeout = errorCode === "P2024";
    if (totalMs < this.slowRequestMs && !poolTimeout) return;

    const route = `${request.baseUrl ?? ""}${request.route?.path ?? request.path}`;
    const fields = {
      event: poolTimeout ? "db_pool_timeout" : "slow_api_request",
      method: request.method,
      route,
      status: responseStatus(response, error),
      totalMs: Math.round(totalMs),
      dbQueryCount: store.dbQueryCount,
      dbDurationSumMs: Math.round(store.dbDurationSumMs),
      maxDbQueryMs: Math.round(store.maxDbQueryMs),
      slowDbQueryCount: store.slowDbQueryCount,
      ...(errorCode ? { errorCode } : {}),
    };
    this.logger.warn(JSON.stringify(fields));
  }
}
