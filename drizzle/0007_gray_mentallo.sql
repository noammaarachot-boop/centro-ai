ALTER TABLE "organizations" ADD COLUMN "onboarding_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "full_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "terms_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "privacy_accepted_at" timestamp with time zone;--> statement-breakpoint
-- Backfill: every organization that predates the Epic 2 onboarding gate has
-- already been through manual "Office Setup" in practice (it's how they got
-- data in at all). Mark them onboarded so the new gate doesn't send existing
-- pilot orgs back into that flow on their next login; only genuinely new
-- (post-migration) organizations start with onboarding_completed_at unset.
UPDATE "organizations" SET "onboarding_completed_at" = COALESCE("automation_activated_at", now()) WHERE "onboarding_completed_at" IS NULL;