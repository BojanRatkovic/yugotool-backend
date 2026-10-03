CREATE TYPE "public"."shift_end_reason" AS ENUM('threshold', 'done', 'stuck', 'budget', 'max_shifts', 'error', 'cancelled', 'manual');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('running', 'handing_off', 'awaiting_review', 'done', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"station_run_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"status" "shift_status" DEFAULT 'running' NOT NULL,
	"session_id" text,
	"context_tokens" integer DEFAULT 0 NOT NULL,
	"context_window" integer,
	"handoff_at_pct" integer NOT NULL,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"num_turns" integer DEFAULT 0 NOT NULL,
	"commits" integer DEFAULT 0 NOT NULL,
	"tasks_done" integer DEFAULT 0 NOT NULL,
	"tasks_total" integer DEFAULT 0 NOT NULL,
	"handoff" jsonb,
	"end_reason" "shift_end_reason",
	"handoff_requested" boolean DEFAULT false NOT NULL,
	"stop_after" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_station_run_id_station_runs_id_fk" FOREIGN KEY ("station_run_id") REFERENCES "public"."station_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shifts_station_run_id_idx" ON "shifts" USING btree ("station_run_id");