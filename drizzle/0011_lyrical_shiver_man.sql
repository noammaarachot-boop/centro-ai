ALTER TABLE "clients" ADD COLUMN "learning_mode" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "first_cycle_completed_at" timestamp with time zone;