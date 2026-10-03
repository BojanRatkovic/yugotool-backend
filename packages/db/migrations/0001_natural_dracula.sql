CREATE TYPE "public"."auth_source" AS ENUM('subscription', 'api_key', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."effort_level" AS ENUM('low', 'medium', 'high', 'xhigh', 'max');--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "auth_source" "auth_source";--> statement-breakpoint
ALTER TABLE "station_runs" ADD COLUMN "verdict" jsonb;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "model_override" text;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "effort_override" "effort_level";--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "max_budget_usd" double precision;--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "pr_url" text;