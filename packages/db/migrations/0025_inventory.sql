CREATE TYPE "public"."asset_acquisition" AS ENUM('DIRECT', 'SUBLEASED');--> statement-breakpoint
CREATE TYPE "public"."asset_kind" AS ENUM('POLE', 'BILLBOARD', 'PRISM', 'MESH', 'WALL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."asset_lifecycle" AS ENUM('PROSPECTIVE', 'ACTIVE', 'SUSPENDED', 'DECOMMISSIONED');--> statement-breakpoint
CREATE TYPE "public"."asset_verification" AS ENUM('NOT_VERIFIED', 'TO_BE_VERIFIED', 'FIELD_VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."cost_unit" AS ENUM('MONTH', 'DAY', 'CAMPAIGN');--> statement-breakpoint
CREATE TABLE "advertising_face" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mount_position_id" uuid NOT NULL,
	"face_code" text NOT NULL,
	"facing_bearing" integer,
	"visible_traffic_direction" text,
	"width_m" numeric(6, 2),
	"height_m" numeric(6, 2),
	"dimension_preset_id" uuid,
	"illuminated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "advertising_face_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "advertising_face_code_uq" UNIQUE("mount_position_id","face_code"),
	CONSTRAINT "advertising_face_code_ck" CHECK ("advertising_face"."face_code" IN ('A', 'B', 'C', 'D')),
	CONSTRAINT "advertising_face_bearing_ck" CHECK ("advertising_face"."facing_bearing" IS NULL OR "advertising_face"."facing_bearing" BETWEEN 0 AND 359),
	CONSTRAINT "advertising_face_size_ck" CHECK (("advertising_face"."width_m" IS NULL OR "advertising_face"."width_m" > 0) AND ("advertising_face"."height_m" IS NULL OR "advertising_face"."height_m" > 0))
);
--> statement-breakpoint
CREATE TABLE "asset_block" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"face_id" uuid,
	"period" daterange NOT NULL,
	"reason" text NOT NULL,
	"created_by_membership_id" uuid,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_block_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "asset_block_reason_ck" CHECK (length(btrim("asset_block"."reason")) > 0),
	CONSTRAINT "asset_block_period_ck" CHECK (NOT isempty("asset_block"."period") AND NOT lower_inf("asset_block"."period") AND NOT upper_inf("asset_block"."period"))
);
--> statement-breakpoint
CREATE TABLE "asset_terms" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"acquisition" "asset_acquisition" NOT NULL,
	"owner_organisation_id" uuid,
	"supplier_organisation_id" uuid,
	"cost_amount" numeric(14, 2),
	"cost_unit" "cost_unit",
	"currency" text DEFAULT 'RON' NOT NULL,
	"valid_period" daterange NOT NULL,
	"contract_ref" text,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "asset_terms_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "asset_terms_subleased_ck" CHECK ("asset_terms"."acquisition" <> 'SUBLEASED' OR "asset_terms"."supplier_organisation_id" IS NOT NULL),
	CONSTRAINT "asset_terms_cost_ck" CHECK (("asset_terms"."cost_amount" IS NULL) = ("asset_terms"."cost_unit" IS NULL) AND ("asset_terms"."cost_amount" IS NULL OR "asset_terms"."cost_amount" >= 0)),
	CONSTRAINT "asset_terms_currency_ck" CHECK ("asset_terms"."currency" IN ('RON', 'EUR')),
	CONSTRAINT "asset_terms_period_ck" CHECK (NOT isempty("asset_terms"."valid_period") AND lower_inf("asset_terms"."valid_period") = false)
);
--> statement-breakpoint
CREATE TABLE "asset_type" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"code_prefix" text NOT NULL,
	"default_mount_positions" integer DEFAULT 1 NOT NULL,
	"max_mount_positions" integer,
	"faces_per_mount" integer DEFAULT 1 NOT NULL,
	"faces_booked_together" boolean DEFAULT false NOT NULL,
	"attribute_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "asset_type_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "asset_type_tenant_key_uq" UNIQUE("tenant_id","key"),
	CONSTRAINT "asset_type_key_format_ck" CHECK ("asset_type"."key" ~ '^[a-z][a-z0-9_]*$'),
	CONSTRAINT "asset_type_prefix_ck" CHECK ("asset_type"."code_prefix" ~ '^[A-Z][A-Z0-9]{1,9}$'),
	CONSTRAINT "asset_type_mounts_ck" CHECK ("asset_type"."default_mount_positions" >= 0 AND "asset_type"."faces_per_mount" BETWEEN 1 AND 4 AND ("asset_type"."max_mount_positions" IS NULL OR "asset_type"."max_mount_positions" >= greatest("asset_type"."default_mount_positions", 1)))
);
--> statement-breakpoint
CREATE TABLE "dimension_preset" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"width_m" numeric(6, 2) NOT NULL,
	"height_m" numeric(6, 2) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "dimension_preset_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "dimension_preset_tenant_name_uq" UNIQUE("tenant_id","name"),
	CONSTRAINT "dimension_preset_size_ck" CHECK ("dimension_preset"."width_m" > 0 AND "dimension_preset"."height_m" > 0)
);
--> statement-breakpoint
CREATE TABLE "mount_position" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"position_no" integer NOT NULL,
	"orientation_bearing" integer,
	"height_m" numeric(5, 2),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mount_position_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "mount_position_no_uq" UNIQUE("asset_id","position_no"),
	CONSTRAINT "mount_position_no_ck" CHECK ("mount_position"."position_no" >= 1),
	CONSTRAINT "mount_position_bearing_ck" CHECK ("mount_position"."orientation_bearing" IS NULL OR "mount_position"."orientation_bearing" BETWEEN 0 AND 359)
);
--> statement-breakpoint
CREATE TABLE "ooh_asset" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"asset_type_id" uuid NOT NULL,
	"location" geography(Point,4326) NOT NULL,
	"address" text,
	"city" text,
	"county" text,
	"lifecycle" "asset_lifecycle" DEFAULT 'PROSPECTIVE' NOT NULL,
	"verification_status" "asset_verification" DEFAULT 'NOT_VERIFIED' NOT NULL,
	"last_verified_at" timestamp with time zone,
	"street_view_ref" jsonb,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"suspend_reason" text,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "ooh_asset_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "ooh_asset_code_uq" UNIQUE("tenant_id","code"),
	CONSTRAINT "ooh_asset_suspended_ck" CHECK (("ooh_asset"."lifecycle" = 'SUSPENDED') = (length(btrim(coalesce("ooh_asset"."suspend_reason", ''))) > 0)),
	CONSTRAINT "ooh_asset_verified_ck" CHECK ("ooh_asset"."verification_status" <> 'FIELD_VERIFIED' OR "ooh_asset"."last_verified_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "advertising_face" ADD CONSTRAINT "advertising_face_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_face" ADD CONSTRAINT "advertising_face_mount_fk" FOREIGN KEY ("tenant_id","mount_position_id") REFERENCES "public"."mount_position"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "advertising_face" ADD CONSTRAINT "advertising_face_preset_fk" FOREIGN KEY ("tenant_id","dimension_preset_id") REFERENCES "public"."dimension_preset"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_block" ADD CONSTRAINT "asset_block_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_block" ADD CONSTRAINT "asset_block_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."ooh_asset"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_block" ADD CONSTRAINT "asset_block_face_fk" FOREIGN KEY ("tenant_id","face_id") REFERENCES "public"."advertising_face"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_block" ADD CONSTRAINT "asset_block_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_terms" ADD CONSTRAINT "asset_terms_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_terms" ADD CONSTRAINT "asset_terms_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."ooh_asset"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_terms" ADD CONSTRAINT "asset_terms_owner_fk" FOREIGN KEY ("tenant_id","owner_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_terms" ADD CONSTRAINT "asset_terms_supplier_fk" FOREIGN KEY ("tenant_id","supplier_organisation_id") REFERENCES "public"."organisation"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_terms" ADD CONSTRAINT "asset_terms_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_type" ADD CONSTRAINT "asset_type_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dimension_preset" ADD CONSTRAINT "dimension_preset_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount_position" ADD CONSTRAINT "mount_position_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mount_position" ADD CONSTRAINT "mount_position_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."ooh_asset"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ooh_asset" ADD CONSTRAINT "ooh_asset_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ooh_asset" ADD CONSTRAINT "ooh_asset_type_fk" FOREIGN KEY ("tenant_id","asset_type_id") REFERENCES "public"."asset_type"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ooh_asset" ADD CONSTRAINT "ooh_asset_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_block_asset_idx" ON "asset_block" USING btree ("tenant_id","asset_id");--> statement-breakpoint
CREATE INDEX "asset_terms_supplier_idx" ON "asset_terms" USING btree ("tenant_id","supplier_organisation_id");--> statement-breakpoint
CREATE INDEX "ooh_asset_location_idx" ON "ooh_asset" USING gist ("location");--> statement-breakpoint
CREATE INDEX "ooh_asset_type_idx" ON "ooh_asset" USING btree ("tenant_id","asset_type_id");--> statement-breakpoint
CREATE INDEX "ooh_asset_lifecycle_idx" ON "ooh_asset" USING btree ("tenant_id","lifecycle");