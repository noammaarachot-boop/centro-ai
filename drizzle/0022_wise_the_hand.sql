CREATE TYPE "public"."lead_whatsapp_status" AS ENUM('not_applicable', 'pending', 'sent', 'failed');--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"phone_e164" text,
	"email" text,
	"business_name" text,
	"message" text,
	"source" text NOT NULL,
	"email_sent_at" timestamp with time zone,
	"whatsapp_status" "lead_whatsapp_status" DEFAULT 'pending' NOT NULL,
	"whatsapp_message_id" text,
	"whatsapp_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp_business_account_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp_phone_number_id" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp_display_phone_number" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp_verified_name" text;