ALTER TABLE "organizations" ADD COLUMN "google_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp_connected_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "automation_activated_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "clients_organization_id_phone_idx" ON "clients" USING btree ("organization_id","phone");