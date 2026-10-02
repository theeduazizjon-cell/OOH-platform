CREATE TYPE "public"."task_priority" AS ENUM('LOW', 'NORMAL', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."task_source" AS ENUM('USER', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('OPEN', 'IN_PROGRESS', 'DONE', 'CANCELLED');--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"notes" text,
	"status" "task_status" DEFAULT 'OPEN' NOT NULL,
	"priority" "task_priority" DEFAULT 'NORMAL' NOT NULL,
	"source" "task_source" DEFAULT 'USER' NOT NULL,
	"subject_type" text,
	"subject_id" uuid,
	"organisation_id" uuid,
	"assignee_membership_id" uuid,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"dedupe_key" text,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "task_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "task_title_ck" CHECK (length(btrim("task"."title")) > 0),
	CONSTRAINT "task_subject_ck" CHECK (("task"."subject_type" IS NULL) = ("task"."subject_id" IS NULL) AND ("task"."subject_type" IS NULL OR "task"."subject_type" IN ('organisation', 'opportunity'))),
	CONSTRAINT "task_subject_company_ck" CHECK ("task"."subject_type" IS NULL OR "task"."organisation_id" IS NOT NULL),
	CONSTRAINT "task_completed_ck" CHECK (("task"."status" = 'DONE') = ("task"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_fk" FOREIGN KEY ("tenant_id","assignee_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_dedupe_key_uq" ON "task" USING btree ("tenant_id","dedupe_key") WHERE "task"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "task_assignee_idx" ON "task" USING btree ("tenant_id","assignee_membership_id","status");--> statement-breakpoint
CREATE INDEX "task_organisation_idx" ON "task" USING btree ("tenant_id","organisation_id");--> statement-breakpoint
CREATE INDEX "task_subject_idx" ON "task" USING btree ("tenant_id","subject_type","subject_id");