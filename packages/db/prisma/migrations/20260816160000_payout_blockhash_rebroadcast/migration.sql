-- Persist the exact signed transaction and its validity window so the worker
-- can safely rebroadcast after process restarts and permit a new signature
-- only after the previous blockhash has expired.
ALTER TABLE "Payout"
ADD COLUMN "recentBlockhash" TEXT,
ADD COLUMN "lastValidBlockHeight" BIGINT,
ADD COLUMN "signedTransactionBase64" TEXT,
ADD COLUMN "lastBroadcastAt" TIMESTAMP(3),
ADD COLUMN "broadcastAttempts" INTEGER NOT NULL DEFAULT 0;
