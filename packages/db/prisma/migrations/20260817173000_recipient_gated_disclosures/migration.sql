CREATE TYPE "DisclosureAccessMode" AS ENUM ('LINK', 'RECIPIENT_OTP');

ALTER TABLE "DisclosureGrant"
ADD COLUMN "accessMode" "DisclosureAccessMode" NOT NULL DEFAULT 'LINK';
