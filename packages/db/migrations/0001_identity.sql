CREATE TYPE "public"."membership_kind" AS ENUM('INTERNAL', 'EXTERNAL');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('INVITED', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."permission_scope" AS ENUM('ALL', 'OWN', 'ASSIGNED', 'ORGANISATION');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TABLE "app_user" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" "citext" NOT NULL,
	"password_hash" text,
	"display_name" text NOT NULL,
	"phone" text,
	"locale" text,
	"last_login_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "app_user_email_uq" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" "membership_kind" DEFAULT 'INTERNAL' NOT NULL,
	"status" "membership_status" DEFAULT 'INVITED' NOT NULL,
	"organisation_id" uuid,
	"perms_version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "membership_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "membership_tenant_user_uq" UNIQUE("tenant_id","user_id"),
	CONSTRAINT "membership_external_has_organisation_ck" CHECK ("membership"."kind" = 'INTERNAL' OR "membership"."organisation_id" IS NOT NULL OR "membership"."status" = 'INVITED')
);
--> statement-breakpoint
CREATE TABLE "membership_role" (
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_role_pk" PRIMARY KEY("membership_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "role" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false NOT NULL,
	"is_external" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "role_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "role_tenant_key_uq" UNIQUE("tenant_id","key"),
	CONSTRAINT "role_key_format_ck" CHECK ("role"."key" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE "role_permission" (
	"tenant_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission_key" text NOT NULL,
	"scope" "permission_scope" DEFAULT 'ALL' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permission_pk" PRIMARY KEY("role_id","permission_key"),
	CONSTRAINT "role_permission_key_format_ck" CHECK ("role_permission"."permission_key" ~ '^[a-z_]+(\.[a-z_]+)+$')
);
--> statement-breakpoint
CREATE TABLE "tenant" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" "tenant_status" DEFAULT 'ACTIVE' NOT NULL,
	"locale" text DEFAULT 'ro-RO' NOT NULL,
	"timezone" text DEFAULT 'Europe/Bucharest' NOT NULL,
	"default_currency" text DEFAULT 'RON' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "tenant_slug_uq" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_role" ADD CONSTRAINT "membership_role_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."role"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role" ADD CONSTRAINT "role_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_fk" FOREIGN KEY ("tenant_id","role_id") REFERENCES "public"."role"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "membership_role_role_idx" ON "membership_role" USING btree ("tenant_id","role_id");