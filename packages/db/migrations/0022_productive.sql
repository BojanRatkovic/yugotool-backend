CREATE TABLE "productive_connection" (
	"id" text PRIMARY KEY DEFAULT 'default' NOT NULL,
	"token" text NOT NULL,
	"organization_id" text NOT NULL,
	"organization_name" text NOT NULL,
	"person_id" text,
	"person_name" text,
	"organizations" jsonb NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_orders" ADD COLUMN "source" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "work_orders_source_idx" ON "work_orders" USING btree ("project_id",("source"->>'provider'),("source"->>'id')) WHERE "work_orders"."source" is not null;