ALTER TABLE "clients" ADD COLUMN "drive_folder_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "drive_deleted_at" timestamp with time zone;