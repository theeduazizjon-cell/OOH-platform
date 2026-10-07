ALTER TABLE "task" DROP CONSTRAINT "task_subject_ck";--> statement-breakpoint
DROP INDEX "outbox_event_pending_idx";--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "campaign_id" uuid;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_event" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_campaign_fk" FOREIGN KEY ("tenant_id","campaign_id") REFERENCES "public"."campaign"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_campaign_idx" ON "task" USING btree ("tenant_id","campaign_id");--> statement-breakpoint
CREATE INDEX "outbox_event_pending_idx" ON "outbox_event" USING btree ("next_attempt_at","occurred_at") WHERE "outbox_event"."dispatched_at" IS NULL AND "outbox_event"."failed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_subject_campaign_ck" CHECK ("task"."subject_type" NOT IN ('campaign', 'campaign_location') OR "task"."campaign_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_subject_ck" CHECK (("task"."subject_type" IS NULL) = ("task"."subject_id" IS NULL) AND ("task"."subject_type" IS NULL OR "task"."subject_type" IN ('organisation', 'opportunity', 'campaign', 'campaign_location')));