CREATE TABLE "invitation" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"email" "citext" NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_membership_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitation_tenant_id_id_uq" UNIQUE("tenant_id","id"),
	CONSTRAINT "invitation_not_accepted_and_revoked_ck" CHECK ("invitation"."accepted_at" IS NULL OR "invitation"."revoked_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_membership_fk" FOREIGN KEY ("tenant_id","membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_invited_by_fk" FOREIGN KEY ("tenant_id","invited_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_one_pending_per_membership_uq" ON "invitation" USING btree ("tenant_id","membership_id") WHERE "invitation"."accepted_at" IS NULL AND "invitation"."revoked_at" IS NULL;