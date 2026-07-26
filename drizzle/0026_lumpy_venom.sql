CREATE TYPE "public"."job_run_status" AS ENUM('success', 'failed');--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_name" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"status" "job_run_status" NOT NULL,
	"result_summary" jsonb
);
