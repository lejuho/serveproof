-- CreateEnum
CREATE TYPE "EvidenceIngestSource" AS ENUM ('CSV_UPLOAD', 'PROVIDER_API');

-- AlterTable
ALTER TABLE "TipEvidence" ADD COLUMN     "ingestSource" "EvidenceIngestSource" NOT NULL DEFAULT 'CSV_UPLOAD';

-- AlterTable
ALTER TABLE "ShiftEvidence" ADD COLUMN     "ingestSource" "EvidenceIngestSource" NOT NULL DEFAULT 'CSV_UPLOAD';


-- Backfill: rows synced from the Square provider API predate this column
UPDATE "TipEvidence" SET "ingestSource" = 'PROVIDER_API' WHERE "provider" = 'square';
UPDATE "ShiftEvidence" SET "ingestSource" = 'PROVIDER_API' WHERE "provider" = 'square';
