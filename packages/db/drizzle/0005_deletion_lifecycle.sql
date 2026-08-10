DROP INDEX "deletion_requests_status_due_idx";--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "lease_token_hash" text;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "last_error_category" text;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "last_error_code" text;--> statement-breakpoint
UPDATE "deletion_requests"
SET
  "status" = 'failed',
  "attempt_count" = greatest("attempt_count", 1),
  "last_attempt_at" = coalesce("processing_started_at", statement_timestamp()),
  "processing_started_at" = null,
  "last_error_category" = 'database',
  "last_error_code" = 'migration_recovery'
WHERE "status" IN ('processing', 'failed');--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_requests_one_account_request_idx" ON "deletion_requests" USING btree ("owner_user_id") WHERE "deletion_requests"."scope" = 'account';--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_requests_one_interview_request_idx" ON "deletion_requests" USING btree ("interview_id") WHERE "deletion_requests"."scope" = 'interview';--> statement-breakpoint
CREATE INDEX "deletion_requests_status_due_idx" ON "deletion_requests" USING btree ("status","purge_due_at","lease_expires_at");--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_attempt_count_check" CHECK ("deletion_requests"."attempt_count" >= 0);--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_error_bounds_check" CHECK (
        (
          "deletion_requests"."last_error_category" is null
          and "deletion_requests"."last_error_code" is null
        )
        or (
          length("deletion_requests"."last_error_category") between 1 and 32
          and "deletion_requests"."last_error_category" ~ '^[a-z0-9_]+$'
          and length("deletion_requests"."last_error_code") between 1 and 64
          and "deletion_requests"."last_error_code" ~ '^[a-z0-9_]+$'
        )
      );--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_lifecycle_check" CHECK (
        (
          "deletion_requests"."status" = 'processing'
          and "deletion_requests"."processing_started_at" is not null
          and "deletion_requests"."last_attempt_at" is not null
          and "deletion_requests"."lease_expires_at" is not null
          and "deletion_requests"."lease_owner" is not null
          and "deletion_requests"."lease_token_hash" is not null
          and length(trim("deletion_requests"."lease_owner")) > 0
          and length("deletion_requests"."lease_token_hash") = 64
          and "deletion_requests"."lease_expires_at" > "deletion_requests"."processing_started_at"
          and "deletion_requests"."completed_at" is null
          and "deletion_requests"."last_error_category" is null
          and "deletion_requests"."last_error_code" is null
        )
        or (
          "deletion_requests"."status" in ('pending', 'failed')
          and "deletion_requests"."processing_started_at" is null
          and "deletion_requests"."lease_expires_at" is null
          and "deletion_requests"."lease_owner" is null
          and "deletion_requests"."lease_token_hash" is null
          and "deletion_requests"."completed_at" is null
          and (
            ("deletion_requests"."status" = 'pending' and "deletion_requests"."last_error_category" is null and "deletion_requests"."last_error_code" is null)
            or
            ("deletion_requests"."status" = 'failed' and "deletion_requests"."last_error_category" is not null and "deletion_requests"."last_error_code" is not null)
          )
        )
        or (
          "deletion_requests"."status" = 'completed'
          and "deletion_requests"."processing_started_at" is null
          and "deletion_requests"."lease_expires_at" is null
          and "deletion_requests"."lease_owner" is null
          and "deletion_requests"."lease_token_hash" is null
          and "deletion_requests"."completed_at" is not null
          and "deletion_requests"."last_error_category" is null
          and "deletion_requests"."last_error_code" is null
        )
      );--> statement-breakpoint
ALTER TABLE "purge_audit_events" ADD CONSTRAINT "purge_audit_events_subject_hash_check" CHECK (length("purge_audit_events"."subject_identifier_hash") = 64 and "purge_audit_events"."subject_identifier_hash" ~ '^[0-9a-f]{64}$');