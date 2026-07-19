CREATE TABLE "business_type_learned_synonyms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"business_type_id" uuid NOT NULL,
	"source_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "business_types" ADD COLUMN "canonical_key" text;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "business_type_confidence" integer;--> statement-breakpoint
ALTER TABLE "clients" ADD COLUMN "imported_business_type_text" text;--> statement-breakpoint
ALTER TABLE "business_type_learned_synonyms" ADD CONSTRAINT "business_type_learned_synonyms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_type_learned_synonyms" ADD CONSTRAINT "business_type_learned_synonyms_business_type_id_business_types_id_fk" FOREIGN KEY ("business_type_id") REFERENCES "public"."business_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_type_learned_synonyms_org_text_idx" ON "business_type_learned_synonyms" USING btree ("organization_id","source_text");
--> statement-breakpoint
-- Backfill canonical_key for every organization's existing rows of the five
-- standard starter types, matched by their current (Hebrew) display name —
-- this is the last time matching ever depends on that name. From here on,
-- src/lib/ai/businessTypeClassifier.ts matches against canonical_key only,
-- so renaming a type's label can never again silently break classification
-- (see drizzle/0009_hebrew_business_type_names.sql for the incident this
-- closes out for good).
UPDATE "business_types" SET "canonical_key" = 'limited_company' WHERE "name" = 'חברה בע"מ';
--> statement-breakpoint
UPDATE "business_types" SET "canonical_key" = 'authorized_dealer' WHERE "name" = 'עוסק מורשה';
--> statement-breakpoint
UPDATE "business_types" SET "canonical_key" = 'exempt_dealer' WHERE "name" = 'עוסק פטור';
--> statement-breakpoint
UPDATE "business_types" SET "canonical_key" = 'nonprofit' WHERE "name" = 'עמותה';
--> statement-breakpoint
UPDATE "business_types" SET "canonical_key" = 'payroll_only' WHERE "name" = 'שכר בלבד';