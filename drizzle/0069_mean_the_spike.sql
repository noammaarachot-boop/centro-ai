ALTER TABLE "organizations" ADD COLUMN "whatsapp_health_ok" boolean;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp_health_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp_health_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "google_health_ok" boolean;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "google_health_reason" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "google_health_checked_at" timestamp with time zone;