CREATE TYPE "public"."pipeline_stage_kind" AS ENUM('OPEN', 'WON', 'LOST');--> statement-breakpoint
CREATE TABLE "activity_type" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "activity_type_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "activity_type_tenant_key_uq" UNIQUE("tenant_id","key"),
	CONSTRAINT "activity_type_key_format_ck" CHECK ("activity_type"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "pipeline" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pipeline_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "pipeline_stage" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" "pipeline_stage_kind" NOT NULL,
	"position" integer NOT NULL,
	"probability" integer,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "pipeline_stage_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "pipeline_stage_tenant_id_kind_uq" UNIQUE("tenant_id","id","kind"),
	CONSTRAINT "pipeline_stage_probability_ck" CHECK ("pipeline_stage"."probability" IS NULL OR "pipeline_stage"."probability" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid,
	"opportunity_id" uuid,
	"activity_type_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"subject" text NOT NULL,
	"body" text,
	"author_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "activity_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "activity_subject_ck" CHECK (length(btrim("activity"."subject")) > 0)
);
--> statement-breakpoint
CREATE TABLE "opportunity" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"contact_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"name" text NOT NULL,
	"estimated_value" numeric(14, 2),
	"currency" text DEFAULT 'RON' NOT NULL,
	"expected_close_date" date,
	"probability" integer,
	"pipeline_stage_id" uuid NOT NULL,
	"stage_kind" "pipeline_stage_kind" NOT NULL,
	"source" text,
	"next_action" text,
	"next_follow_up_date" date,
	"lost_reason" text,
	"closed_at" timestamp with time zone,
	"created_by_membership_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "opportunity_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "opportunity_tenant_organisation_id_uq" UNIQUE("tenant_id","organisation_id","id"),
	CONSTRAINT "opportunity_name_ck" CHECK (length(btrim("opportunity"."name")) > 0),
	CONSTRAINT "opportunity_currency_ck" CHECK ("opportunity"."currency" IN ('RON', 'EUR')),
	CONSTRAINT "opportunity_value_ck" CHECK ("opportunity"."estimated_value" IS NULL OR "opportunity"."estimated_value" >= 0),
	CONSTRAINT "opportunity_probability_ck" CHECK ("opportunity"."probability" IS NULL OR "opportunity"."probability" BETWEEN 0 AND 100),
	CONSTRAINT "opportunity_won_ck" CHECK ("opportunity"."stage_kind" <> 'WON' OR ("opportunity"."estimated_value" IS NOT NULL AND "opportunity"."expected_close_date" IS NOT NULL)),
	CONSTRAINT "opportunity_lost_ck" CHECK ("opportunity"."stage_kind" <> 'LOST' OR length(btrim(coalesce("opportunity"."lost_reason", ''))) > 0),
	CONSTRAINT "opportunity_closed_at_ck" CHECK (("opportunity"."stage_kind" = 'OPEN') = ("opportunity"."closed_at" IS NULL))
);
--> statement-breakpoint
-- Moved before the foreign keys that reference it (drizzle-kit emitted it last).
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_organisation_id_uq" UNIQUE("tenant_id","organisation_id","id");--> statement-breakpoint
ALTER TABLE "activity_type" ADD CONSTRAINT "activity_type_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline" ADD CONSTRAINT "pipeline_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pipeline_stage" ADD CONSTRAINT "pipeline_stage_pipeline_fk" FOREIGN KEY ("tenant_id","pipeline_id") REFERENCES "public"."pipeline"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_contact_fk" FOREIGN KEY ("tenant_id","organisation_id","contact_id") REFERENCES "public"."contact"("tenant_id","organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_opportunity_fk" FOREIGN KEY ("tenant_id","organisation_id","opportunity_id") REFERENCES "public"."opportunity"("tenant_id","organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_type_fk" FOREIGN KEY ("tenant_id","activity_type_id") REFERENCES "public"."activity_type"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_author_fk" FOREIGN KEY ("tenant_id","author_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_contact_fk" FOREIGN KEY ("tenant_id","organisation_id","contact_id") REFERENCES "public"."contact"("tenant_id","organisation_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_owner_fk" FOREIGN KEY ("tenant_id","owner_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunity" ADD CONSTRAINT "opportunity_stage_fk" FOREIGN KEY ("tenant_id","pipeline_stage_id","stage_kind") REFERENCES "public"."pipeline_stage"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_one_default_uq" ON "pipeline" USING btree ("tenant_id") WHERE "pipeline"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "pipeline_stage_one_won_lost_uq" ON "pipeline_stage" USING btree ("pipeline_id","kind") WHERE "pipeline_stage"."kind" <> 'OPEN';--> statement-breakpoint
CREATE INDEX "activity_organisation_time_idx" ON "activity" USING btree ("tenant_id","organisation_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_opportunity_idx" ON "activity" USING btree ("tenant_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "opportunity_stage_idx" ON "opportunity" USING btree ("tenant_id","pipeline_stage_id");--> statement-breakpoint
CREATE INDEX "opportunity_organisation_idx" ON "opportunity" USING btree ("tenant_id","organisation_id");--> statement-breakpoint
CREATE INDEX "opportunity_owner_idx" ON "opportunity" USING btree ("tenant_id","owner_membership_id");
