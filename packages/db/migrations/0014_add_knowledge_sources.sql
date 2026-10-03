CREATE TYPE "public"."knowledge_source_kind" AS ENUM('git_local', 'git_remote', 'path');--> statement-breakpoint
CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" "knowledge_source_kind" NOT NULL,
	"location" text NOT NULL,
	"branch" text,
	"entry_file" text,
	"excludes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_sha" text,
	"last_synced_at" timestamp with time zone,
	"last_entry_file" text,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_knowledge" (
	"project_id" uuid NOT NULL,
	"source_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "project_knowledge_project_id_source_id_pk" PRIMARY KEY("project_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "project_knowledge" ADD CONSTRAINT "project_knowledge_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_knowledge" ADD CONSTRAINT "project_knowledge_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_knowledge_source_id_idx" ON "project_knowledge" USING btree ("source_id");