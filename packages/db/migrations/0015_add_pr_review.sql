CREATE TYPE "public"."line_kind" AS ENUM('build', 'review');--> statement-breakpoint
CREATE TYPE "public"."work_order_kind" AS ENUM('build', 'review');--> statement-breakpoint
DROP INDEX "lines_project_id_idx";--> statement-breakpoint
ALTER TABLE "lines" ADD COLUMN "kind" "line_kind" DEFAULT 'build' NOT NULL;--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "kind" "work_order_kind" DEFAULT 'build' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "pull_request" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "lines_project_id_kind_idx" ON "lines" USING btree ("project_id","kind");