CREATE TYPE "public"."campaign_status" AS ENUM('ACTIVE', 'ON_HOLD', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."location_status" AS ENUM('DRAFT', 'RESEARCH', 'AWAITING_APPROVAL', 'APPROVED', 'IN_PRODUCTION', 'READY_FOR_INSTALLATION', 'INSTALLING', 'LIVE', 'REMOVAL_DUE', 'REMOVING', 'COMPLETED', 'CANCELLED', 'ON_HOLD');--> statement-breakpoint
CREATE TABLE "campaign" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"client_organisation_id" uuid NOT NULL,
	"agency_organisation_id" uuid,
	"opportunity_id" uuid,
	"owner_membership_id" uuid NOT NULL,
	"status" "campaign_status" DEFAULT 'ACTIVE' NOT NULL,
	"hold_reason" text,
	"cancel_reason" text,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "campaign_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "campaign_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "campaign_name_ck" CHECK (length(btrim("campaign"."name")) > 0),
	CONSTRAINT "campaign_agency_not_client_ck" CHECK ("campaign"."agency_organisation_id" IS DISTINCT FROM "campaign"."client_organisation_id"),
	CONSTRAINT "campaign_cancelled_ck" CHECK (("campaign"."status" = 'CANCELLED') = (length(btrim(coalesce("campaign"."cancel_reason", ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "campaign_location" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"brief_line_id" uuid,
	"name" text NOT NULL,
	"address" text,
	"city" text,
	"county" text,
	"start_date" date,
	"end_date" date,
	"requested_units" integer,
	"buyer_membership_id" uuid,
	"status" "location_status" DEFAULT 'DRAFT' NOT NULL,
	"previous_status" "location_status",
	"hold_reason" text,
	"cancel_reason" text,
	"research_radius_m" integer,
	"live_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "campaign_location_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "campaign_location_name_ck" CHECK (length(btrim("campaign_location"."name")) > 0),
	CONSTRAINT "campaign_location_units_ck" CHECK ("campaign_location"."requested_units" IS NULL OR "campaign_location"."requested_units" > 0),
	CONSTRAINT "campaign_location_radius_ck" CHECK ("campaign_location"."research_radius_m" IS NULL OR "campaign_location"."research_radius_m" BETWEEN 50 AND 50000),
	CONSTRAINT "campaign_location_dates_ck" CHECK ("campaign_location"."start_date" IS NULL OR "campaign_location"."end_date" IS NULL OR "campaign_location"."end_date" >= "campaign_location"."start_date"),
	CONSTRAINT "campaign_location_hold_ck" CHECK (("campaign_location"."status" = 'ON_HOLD') = ("campaign_location"."previous_status" IS NOT NULL) AND ("campaign_location"."previous_status" IS NULL OR "campaign_location"."previous_status" NOT IN ('ON_HOLD', 'COMPLETED', 'CANCELLED'))),
	CONSTRAINT "campaign_location_cancelled_ck" CHECK (("campaign_location"."status" = 'CANCELLED') = (length(btrim(coalesce("campaign_location"."cancel_reason", ''))) > 0))
);
--> statement-breakpoint
ALTER TABLE "brief" ADD COLUMN "converted_campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "brief" ADD COLUMN "converted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_client_fk" FOREIGN KEY ("tenant_id","client_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_agency_fk" FOREIGN KEY ("tenant_id","agency_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_opportunity_fk" FOREIGN KEY ("tenant_id","opportunity_id") REFERENCES "public"."opportunity"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_owner_fk" FOREIGN KEY ("tenant_id","owner_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign" ADD CONSTRAINT "campaign_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_campaign_fk" FOREIGN KEY ("tenant_id","campaign_id") REFERENCES "public"."campaign"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_brief_line_fk" FOREIGN KEY ("tenant_id","brief_line_id") REFERENCES "public"."brief_line"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_buyer_fk" FOREIGN KEY ("tenant_id","buyer_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_client_idx" ON "campaign" USING btree ("tenant_id","client_organisation_id");--> statement-breakpoint
CREATE INDEX "campaign_agency_idx" ON "campaign" USING btree ("tenant_id","agency_organisation_id");--> statement-breakpoint
CREATE INDEX "campaign_status_idx" ON "campaign" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "campaign_location_campaign_idx" ON "campaign_location" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE INDEX "campaign_location_status_idx" ON "campaign_location" USING btree ("tenant_id","status");--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_converted_campaign_fk" FOREIGN KEY ("tenant_id","converted_campaign_id") REFERENCES "public"."campaign"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brief" ADD CONSTRAINT "brief_converted_ck" CHECK (("brief"."status" = 'CONVERTED') = ("brief"."converted_campaign_id" IS NOT NULL AND "brief"."converted_at" IS NOT NULL));