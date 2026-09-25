CREATE TABLE "refresh_token" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"active_tenant_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"replaced_by_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"ip" "inet",
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_active_tenant_id_tenant_id_fk" FOREIGN KEY ("active_tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refresh_token_family_idx" ON "refresh_token" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_token_user_idx" ON "refresh_token" USING btree ("user_id");