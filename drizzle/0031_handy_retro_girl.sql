ALTER TABLE "organizations" ADD COLUMN "document_collection_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Backfill: enable automated document collection ONLY for organizations
-- that already have a real WhatsApp connection. Orgs with no connected
-- number stay false. Idempotent (safe to re-run: the WHERE clause narrows
-- to connected orgs and the value is a fixed true).
UPDATE "organizations" SET "document_collection_enabled" = true WHERE "whatsapp_connected_at" IS NOT NULL;