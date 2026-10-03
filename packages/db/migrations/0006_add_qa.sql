CREATE TYPE "public"."finding_severity" AS ENUM('critical', 'important', 'minor');--> statement-breakpoint
CREATE TYPE "public"."qa_check_kind" AS ENUM('visual', 'scenario', 'console', 'a11y');--> statement-breakpoint
CREATE TYPE "public"."qa_check_status" AS ENUM('pass', 'fail', 'changed', 'intended', 'error');--> statement-breakpoint
CREATE TYPE "public"."qa_run_status" AS ENUM('running', 'passed', 'failed', 'error');--> statement-breakpoint
ALTER TYPE "public"."run_event_type" ADD VALUE 'image';--> statement-breakpoint
CREATE TABLE "qa_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"qa_run_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"name" text NOT NULL,
	"kind" "qa_check_kind" NOT NULL,
	"viewport" text,
	"theme" text,
	"path" text,
	"status" "qa_check_status" NOT NULL,
	"diff_pct" double precision,
	"base_shot" text,
	"pr_shot" text,
	"diff_shot" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"note" text,
	"severity" "finding_severity",
	"accepted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "qa_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_run_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"status" "qa_run_status" DEFAULT 'running' NOT NULL,
	"base_sha" text,
	"pr_sha" text,
	"base_url" text,
	"pr_url" text,
	"summary" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "preview" jsonb;--> statement-breakpoint
ALTER TABLE "qa_checks" ADD CONSTRAINT "qa_checks_qa_run_id_qa_runs_id_fk" FOREIGN KEY ("qa_run_id") REFERENCES "public"."qa_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "qa_runs" ADD CONSTRAINT "qa_runs_station_run_id_station_runs_id_fk" FOREIGN KEY ("station_run_id") REFERENCES "public"."station_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "qa_checks_qa_run_id_idx" ON "qa_checks" USING btree ("qa_run_id");--> statement-breakpoint
CREATE INDEX "qa_runs_station_run_id_idx" ON "qa_runs" USING btree ("station_run_id");