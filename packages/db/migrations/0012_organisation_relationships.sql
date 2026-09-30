CREATE TYPE "public"."organisation_relationship_kind" AS ENUM('AGENCY_OF', 'SUPPLIER_TO', 'PARENT_OF');--> statement-breakpoint
CREATE TABLE "organisation_relationship" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_organisation_id" uuid NOT NULL,
	"to_organisation_id" uuid NOT NULL,
	"kind" "organisation_relationship_kind" NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_relationship_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "organisation_relationship_uq" UNIQUE("tenant_id","from_organisation_id","to_organisation_id","kind"),
	CONSTRAINT "organisation_relationship_not_self_ck" CHECK ("organisation_relationship"."from_organisation_id" <> "organisation_relationship"."to_organisation_id")
);
--> statement-breakpoint
ALTER TABLE "organisation_relationship" ADD CONSTRAINT "organisation_relationship_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_relationship" ADD CONSTRAINT "organisation_relationship_from_fk" FOREIGN KEY ("tenant_id","from_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_relationship" ADD CONSTRAINT "organisation_relationship_to_fk" FOREIGN KEY ("tenant_id","to_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_relationship" ADD CONSTRAINT "organisation_relationship_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organisation_relationship_to_idx" ON "organisation_relationship" USING btree ("tenant_id","to_organisation_id");