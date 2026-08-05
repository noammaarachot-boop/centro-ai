ALTER TABLE "collection_requests" ADD COLUMN "drive_client_folder_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "whatsapp_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "documents_whatsapp_message_id_idx" ON "documents" USING btree ("whatsapp_message_id") WHERE "documents"."whatsapp_message_id" is not null;