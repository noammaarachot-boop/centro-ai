ALTER TABLE "messages" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_key_idx" ON "messages" USING btree ("idempotency_key");