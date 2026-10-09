CREATE TYPE "public"."file_purpose" AS ENUM('ASSET_PHOTO', 'ATTACHMENT', 'ARTWORK', 'SIMULATION', 'STUDY_EXPORT');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('PENDING', 'READY', 'QUARANTINED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."file_visibility" AS ENUM('INTERNAL', 'EXTERNAL');--> statement-breakpoint
CREATE TABLE "file_link" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"purpose" "file_purpose" NOT NULL,
	"visibility" "file_visibility" DEFAULT 'INTERNAL' NOT NULL,
	"created_by_membership_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_link_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "file_link_uq" UNIQUE("file_id","subject_type","subject_id","purpose"),
	CONSTRAINT "file_link_subject_type_ck" CHECK ("file_link"."subject_type" IN ('asset'))
);
--> statement-breakpoint
CREATE TABLE "file_object" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"original_name" text NOT NULL,
	"mime" text NOT NULL,
	"detected_mime" text,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"status" "file_status" DEFAULT 'PENDING' NOT NULL,
	"status_reason" text,
	"width" integer,
	"height" integer,
	"derivatives" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scan" jsonb,
	"uploaded_by_membership_id" uuid,
	"uploaded_at" timestamp with time zone,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "file_object_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "file_object_storage_key_uq" UNIQUE("storage_key"),
	CONSTRAINT "file_object_sha256_ck" CHECK ("file_object"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "file_object_size_ck" CHECK ("file_object"."size_bytes" > 0),
	CONSTRAINT "file_object_name_ck" CHECK (length(btrim("file_object"."original_name")) > 0),
	CONSTRAINT "file_object_processed_ck" CHECK ("file_object"."status" = 'PENDING' OR "file_object"."processed_at" IS NOT NULL),
	CONSTRAINT "file_object_reason_ck" CHECK ("file_object"."status" NOT IN ('QUARANTINED', 'REJECTED') OR "file_object"."status_reason" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "file_link" ADD CONSTRAINT "file_link_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_link" ADD CONSTRAINT "file_link_file_fk" FOREIGN KEY ("tenant_id","file_id") REFERENCES "public"."file_object"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_link" ADD CONSTRAINT "file_link_created_by_fk" FOREIGN KEY ("tenant_id","created_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_object" ADD CONSTRAINT "file_object_uploaded_by_fk" FOREIGN KEY ("tenant_id","uploaded_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_link_subject_idx" ON "file_link" USING btree ("tenant_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "file_object_pending_idx" ON "file_object" USING btree ("created_at") WHERE "file_object"."status" = 'PENDING';