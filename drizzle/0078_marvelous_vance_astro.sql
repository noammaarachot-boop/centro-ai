CREATE TABLE "attention_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"collection_request_id" uuid NOT NULL,
	"reason_kind" text NOT NULL,
	"source_id" text DEFAULT '' NOT NULL,
	"occurrence_at" timestamp with time zone NOT NULL,
	"reason_detail" text,
	"dismissed_by_user_id" uuid,
	"dismissed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attention_dismissals" ADD CONSTRAINT "attention_dismissals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_dismissals" ADD CONSTRAINT "attention_dismissals_collection_request_id_collection_requests_id_fk" FOREIGN KEY ("collection_request_id") REFERENCES "public"."collection_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attention_dismissals" ADD CONSTRAINT "attention_dismissals_dismissed_by_user_id_users_id_fk" FOREIGN KEY ("dismissed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "attention_dismissals_occurrence_idx" ON "attention_dismissals" USING btree ("organization_id","collection_request_id","reason_kind","source_id","occurrence_at");