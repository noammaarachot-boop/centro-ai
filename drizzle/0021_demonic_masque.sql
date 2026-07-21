ALTER TABLE "organizations" ADD COLUMN "google_access_token_enc" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "google_refresh_token_enc" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "google_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "google_drive_folder_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "google_drive_folder_name" text;