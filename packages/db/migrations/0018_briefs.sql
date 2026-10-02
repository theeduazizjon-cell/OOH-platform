CREATE TYPE "public"."brief_source" AS ENUM('MANUAL', 'OPPORTUNITY', 'EMAIL', 'PORTAL', 'API');--> statement-breakpoint
CREATE TYPE "public"."brief_status" AS ENUM('DRAFT', 'CONFIRMED', 'CONVERTED', 'DISCARDED');--> statement-breakpoint
CREATE TABLE "brief" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"title" text NOT NULL,
	"source" "brief_source" DEFAULT 'MANUAL' NOT NULL,
	"status" "brief_status" DEFAULT 'DRAFT' NOT NULL,
	"client_organisation_id" uuid,
	"agency_organisation_id" uuid,
	"opportunity_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"requested_start" date,
	"requested_end" date,
	"dates_tbd" boolean DEFAULT false NOT NULL,
	"deadline" date,
	"budget" numeric(14, 2),
	"currency" text DEFAULT 'RON' NOT NULL,
	"special_requirements" text,
	"discard_reason" text,
	"confirmed_at" timestamp with time zone,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"field_provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inbound_email_id" uuid,
	"ai_run_id" uuid,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "brief_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "brief_title_ck" CHECK (length(btrim("brief"."title")) > 0),
	CONSTRAINT "brief_currency_ck" CHECK ("brief"."currency" IN ('RON', 'EUR')),
	CONSTRAINT "brief_budget_ck" CHECK ("brief"."budget" IS NULL OR "brief"."budget" >= 0),
	CONSTRAINT "brief_dates_ck" CHECK ("brief"."requested_start" IS NULL OR "brief"."requested_end" IS NULL OR "brief"."requested_end" >= "brief"."requested_start"),
	CONSTRAINT "brief_discarded_ck" CHECK (("brief"."status" = 'DISCARDED') = (length(btrim(coalesce("brief"."discard_reason", ''))) > 0)),
	CONSTRAINT "brief_confirmed_ck" CHECK ("brief"."status" NOT IN ('CONFIRMED', 'CONVERTED') OR "brief"."confirmed_at" IS NOT NULL),
	CONSTRAINT "brief_source_opportunity_ck" CHECK ("brief"."source" <> 'OPPORTUNITY' OR "brief"."opportunity_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "brief_line" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brief_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"store_name" text NOT NULL,
	"address" text,
	"city" text,
	"county" text,
	"requested_units" integer,
	"dimension" text,
	"start_date" date,
	"end_date" date,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brief_line_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "brief_line_position_uq" UNIQUE("brief_id","position"),
	CONSTRAINT "brief_line_store_ck" CHECK (length(btrim("brief_line"."store_name")) > 0),
	CONSTRAINT "brief_line_units_ck" CHECK ("brief_line"."requested_units" IS NULL OR "brief_line"."requested_units" > 0),
	CONSTRAINT "brief_line_dates_ck" CHECK ("brief_line"."start_date" IS NULL OR "brief_line"."end_date" IS NULL OR "brief_line"."end_date" >= "brief_line"."start_date")
);
--> statement-breakpoint
CREATE TABLE "outbox_event" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	CONSTRAINT "outbox_event_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "status_history" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"action" text NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_membership_id" uuid,
	"reason" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_history_tenant_id_id_uq" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_client_fk" FOREIGN KEY ("tenant_id","client_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_agency_fk" FOREIGN KEY ("tenant_id","agency_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_opportunity_fk" FOREIGN KEY ("tenant_id","opportunity_id") REFERENCES "public"."opportunity"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_owner_fk" FOREIGN KEY ("tenant_id","owner_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_line" ADD CONSTRAINT "brief_line_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief_line" ADD CONSTRAINT "brief_line_brief_fk" FOREIGN KEY ("tenant_id","brief_id") REFERENCES "public"."brief"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_history" ADD CONSTRAINT "status_history_actor_fk" FOREIGN KEY ("tenant_id","actor_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brief_status_idx" ON "brief" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "brief_client_idx" ON "brief" USING btree ("tenant_id","client_organisation_id");--> statement-breakpoint
CREATE INDEX "brief_opportunity_idx" ON "brief" USING btree ("tenant_id","opportunity_id");--> statement-breakpoint
CREATE INDEX "outbox_event_pending_idx" ON "outbox_event" USING btree ("occurred_at") WHERE "outbox_event"."dispatched_at" IS NULL;--> statement-breakpoint
CREATE INDEX "status_history_subject_idx" ON "status_history" USING btree ("tenant_id","subject_type","subject_id","occurred_at");