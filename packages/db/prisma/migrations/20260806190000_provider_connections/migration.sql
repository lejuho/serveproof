CREATE TYPE "ProviderConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'ERROR', 'REVOKED');

CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "status" "ProviderConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "merchantId" TEXT,
    "locationId" TEXT,
    "encryptedAccessToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "oauthStateHash" TEXT,
    "oauthStateExpiresAt" TIMESTAMP(3),
    "lastSyncStartedAt" TIMESTAMP(3),
    "lastSyncSucceededAt" TIMESTAMP(3),
    "lastSyncFailedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderConnection_venueId_provider_key" ON "ProviderConnection"("venueId", "provider");
CREATE INDEX "ProviderConnection_provider_status_idx" ON "ProviderConnection"("provider", "status");

ALTER TABLE "ProviderConnection" ADD CONSTRAINT "ProviderConnection_venueId_fkey"
FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
