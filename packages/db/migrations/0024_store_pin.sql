CREATE TYPE "public"."geocode_status" AS ENUM('PENDING', 'RESOLVED', 'AMBIGUOUS', 'FAILED', 'CONFIRMED');--> statement-breakpoint
ALTER TABLE "campaign_location" ADD COLUMN "store_point" geography(Point,4326);--> statement-breakpoint
ALTER TABLE "campaign_location" ADD COLUMN "geocode_status" "geocode_status" DEFAULT 'PENDING' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD COLUMN "place_id" text;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD COLUMN "geocoded_address" text;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD COLUMN "geocode_error" text;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD COLUMN "pin_confirmed_by_membership_id" uuid;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD COLUMN "pin_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_pin_confirmed_by_fk" FOREIGN KEY ("tenant_id","pin_confirmed_by_membership_id") REFERENCES "public"."membership"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "campaign_location_store_point_idx" ON "campaign_location" USING gist ("store_point");--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_pin_ck" CHECK (("campaign_location"."geocode_status" IN ('RESOLVED', 'CONFIRMED')) = ("campaign_location"."store_point" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_pin_confirmed_ck" CHECK (("campaign_location"."geocode_status" = 'CONFIRMED') = ("campaign_location"."pin_confirmed_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "campaign_location" ADD CONSTRAINT "campaign_location_research_needs_pin_ck" CHECK ("campaign_location"."status" IN ('DRAFT', 'CANCELLED', 'ON_HOLD') OR "campaign_location"."geocode_status" = 'CONFIRMED');