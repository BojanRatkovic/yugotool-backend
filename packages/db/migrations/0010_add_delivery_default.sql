CREATE TYPE "public"."delivery_mode" AS ENUM('local', 'draft_pr', 'pr');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "delivery_default" "delivery_mode" DEFAULT 'local' NOT NULL;--> statement-breakpoint
UPDATE "projects" SET "delivery_default" = CASE WHEN "local_only" THEN 'local'::"delivery_mode" WHEN "draft_prs" THEN 'draft_pr'::"delivery_mode" ELSE 'pr'::"delivery_mode" END;
