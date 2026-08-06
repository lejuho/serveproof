process.env.NODE_ENV = "test";
process.env.APP_ENV = "local";
process.env.AUTH_SECRET = "serveproof-integration-test-secret";
process.env.REPORT_SIGNING_KEY = "serveproof-integration-report-key";
process.env.PROVIDER_ENCRYPTION_KEY = "serveproof-integration-provider-key";
process.env.SQUARE_APP_ID = "sandbox-test-app-id";
process.env.SQUARE_APP_SECRET = "sandbox-test-app-secret";
process.env.SQUARE_REDIRECT_URI = "http://localhost:3001/providers/square/callback";
process.env.SQUARE_ENVIRONMENT = "sandbox";
process.env.REDIS_URL ??= "redis://127.0.0.1:6379/15";
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://serveproof:serveproof@127.0.0.1:5433/serveproof_test";
