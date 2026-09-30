CREATE TYPE "public"."contact_consent_status" AS ENUM('UNKNOWN', 'OPTED_IN', 'OPTED_OUT');--> statement-breakpoint
CREATE TABLE "contact" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text,
	"name_key" text GENERATED ALWAYS AS (lower(immutable_unaccent(btrim(first_name || ' ' || coalesce(last_name, ''))))) STORED NOT NULL,
	"position" text,
	"phone" text,
	"email" "citext",
	"linkedin" text,
	"is_decision_maker" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"consent_status" "contact_consent_status" DEFAULT 'UNKNOWN' NOT NULL,
	"consent_source" text,
	"consent_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"newsletter_eligible" boolean GENERATED ALWAYS AS (consent_status = 'OPTED_IN' AND unsubscribed_at IS NULL AND archived_at IS NULL AND anonymised_at IS NULL) STORED NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_by_membership_id" uuid,
	"anonymised_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "contact_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "contact_first_name_ck" CHECK (length(btrim("contact"."first_name")) > 0),
	CONSTRAINT "contact_consent_stated_ck" CHECK ("contact"."consent_status" = 'UNKNOWN' OR ("contact"."consent_at" IS NOT NULL AND "contact"."consent_source" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact" ADD CONSTRAINT "contact_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_organisation_idx" ON "contact" USING btree ("tenant_id","organisation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contact_one_primary_per_organisation_uq" ON "contact" USING btree ("tenant_id","organisation_id") WHERE "contact"."is_primary" AND "contact"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "contact_organisation_email_uq" ON "contact" USING btree ("tenant_id","organisation_id","email") WHERE "contact"."email" IS NOT NULL AND "contact"."archived_at" IS NULL;