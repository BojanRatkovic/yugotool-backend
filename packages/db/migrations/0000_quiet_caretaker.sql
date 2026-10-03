CREATE TYPE "public"."run_event_type" AS ENUM('text', 'tool_use', 'tool_result', 'result', 'system', 'error');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('running', 'awaiting_approval', 'succeeded', 'failed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."work_order_status" AS ENUM('backlog', 'running', 'awaiting_approval', 'done', 'failed', 'rejected', 'cancelled');--> statement-breakpoint
CREATE TABLE "lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"stations" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"repo_path" text NOT NULL,
	"base_branch" text DEFAULT 'main' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"station_run_id" uuid,
	"seq" bigserial NOT NULL,
	"type" "run_event_type" NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"workflow_id" text NOT NULL,
	"worktree_path" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "station_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"station_key" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" "run_status" DEFAULT 'running' NOT NULL,
	"session_id" text,
	"output" text,
	"error" text,
	"cost_usd" double precision DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" "work_order_status" DEFAULT 'backlog' NOT NULL,
	"station_key" text,
	"position" double precision DEFAULT 0 NOT NULL,
	"branch" text,
	"current_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lines" ADD CONSTRAINT "lines_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_station_run_id_station_runs_id_fk" FOREIGN KEY ("station_run_id") REFERENCES "public"."station_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "station_runs" ADD CONSTRAINT "station_runs_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lines_project_id_idx" ON "lines" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "run_events_run_id_seq_idx" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "runs_work_order_id_idx" ON "runs" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "station_runs_run_id_idx" ON "station_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "work_orders_project_id_idx" ON "work_orders" USING btree ("project_id");