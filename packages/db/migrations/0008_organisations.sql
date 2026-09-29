CREATE TABLE "organisation_classification" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "organisation_classification_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "organisation_classification_tenant_key_uq" UNIQUE("tenant_id","key"),
	CONSTRAINT "organisation_classification_key_format_ck" CHECK ("organisation_classification"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "organisation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"legal_name" text,
	"name_key" text GENERATED ALWAYS AS (crm_name_key(display_name)) STORED NOT NULL,
	"vat_number" text,
	"website" text,
	"address" text,
	"city" text,
	"county" text,
	"country" text DEFAULT 'RO' NOT NULL,
	"industry" text,
	"notes" text,
	"account_owner_membership_id" uuid,
	"created_by_membership_id" uuid,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "organisation_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "organisation_display_name_ck" CHECK (length(btrim("organisation"."display_name")) > 0),
	CONSTRAINT "organisation_vat_format_ck" CHECK ("organisation"."vat_number" ~ '^[A-Z0-9]{2,20}$'),
	CONSTRAINT "organisation_country_ck" CHECK ("organisation"."country" ~ '^[A-Z]{2}$')
);
--> statement-breakpoint
CREATE TABLE "organisation_classification_link" (
	"tenant_id" uuid NOT NULL,
	"organisation_id" uuid NOT NULL,
	"classification_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organisation_classification_link_pk" PRIMARY KEY("organisation_id","classification_id")
);
--> statement-breakpoint
ALTER TABLE "organisation_classification" ADD CONSTRAINT "organisation_classification_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_account_owner_fk" FOREIGN KEY ("tenant_id","account_owner_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation" ADD CONSTRAINT "organisation_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_classification_link" ADD CONSTRAINT "organisation_classification_link_organisation_fk" FOREIGN KEY ("tenant_id","organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organisation_classification_link" ADD CONSTRAINT "organisation_classification_link_classification_fk" FOREIGN KEY ("tenant_id","classification_id") REFERENCES "public"."organisation_classification"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "organisation_tenant_vat_uq" ON "organisation" USING btree ("tenant_id","vat_number") WHERE "organisation"."vat_number" IS NOT NULL AND "organisation"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "organisation_account_owner_idx" ON "organisation" USING btree ("tenant_id","account_owner_membership_id");--> statement-breakpoint
CREATE INDEX "organisation_classification_link_classification_idx" ON "organisation_classification_link" USING btree ("tenant_id","classification_id");