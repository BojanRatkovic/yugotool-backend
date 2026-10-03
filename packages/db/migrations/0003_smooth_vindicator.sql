CREATE TYPE "public"."queue_mode" AS ENUM('asap', 'night');--> statement-breakpoint
ALTER TYPE "public"."run_status" ADD VALUE 'changes_requested' BEFORE 'succeeded';--> statement-breakpoint
ALTER TYPE "public"."work_order_status" ADD VALUE 'queued' BEFORE 'running';--> statement-breakpoint
CREATE TABLE "settings" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"max_concurrent_runs" integer DEFAULT 2 NOT NULL,
	"pause_at_five_hour_pct" integer DEFAULT 85 NOT NULL,
	"pause_at_weekly_pct" integer DEFAULT 95 NOT NULL,
	"night_shift_start" text DEFAULT '22:00' NOT NULL,
	"night_shift_end" text DEFAULT '07:00' NOT NULL,
	"app_url" text DEFAULT 'http://localhost:4800' NOT NULL,
	"desktop_notifications" boolean DEFAULT true NOT NULL,
	"slack_webhook_url" text,
	"telegram_bot_token" text,
	"telegram_chat_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "queue_mode" "queue_mode";--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "queued_at" timestamp with time zone;