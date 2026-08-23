CREATE TABLE "rate_limit_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"first_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_attempts_expires_at_idx" ON "rate_limit_attempts" USING btree ("expires_at");