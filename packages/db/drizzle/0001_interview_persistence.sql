CREATE TYPE "public"."answer_material_kind" AS ENUM('main_answer', 'follow_up_answer', 'supplement');--> statement-breakpoint
CREATE TYPE "public"."deletion_scope" AS ENUM('account', 'interview');--> statement-breakpoint
CREATE TYPE "public"."deletion_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."evaluation_outcome_kind" AS ENUM('scored', 'incorrect', 'irrelevant');--> statement-breakpoint
CREATE TYPE "public"."interview_direction" AS ENUM('go_backend');--> statement-breakpoint
CREATE TYPE "public"."interview_phase" AS ENUM('awaiting_response', 'processing', 'awaiting_continue');--> statement-breakpoint
CREATE TYPE "public"."interview_status" AS ENUM('active', 'report_pending', 'completed', 'early_ended', 'abandoned', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."knowledge_domain" AS ENUM('go_language', 'concurrency_runtime_performance', 'http_rpc_api', 'database_storage', 'cache_messaging_distributed', 'testing_observability_engineering');--> statement-breakpoint
CREATE TYPE "public"."interview_message_kind" AS ENUM('main_question', 'main_answer', 'follow_up_answer', 'supplement', 'question_clarification', 'system_follow_up', 'transition');--> statement-breakpoint
CREATE TYPE "public"."interview_message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."operation_status" AS ENUM('pending', 'processing', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."operation_type" AS ENUM('create_interview', 'submit_answer', 'submit_supplement', 'request_question_clarification', 'mark_question_unknown', 'skip_question', 'continue_interview', 'end_interview_early', 'abandon_interview', 'retry_operation', 'generate_report');--> statement-breakpoint
CREATE TYPE "public"."pending_interview_operation_kind" AS ENUM('answer_analysis', 'question_clarification');--> statement-breakpoint
CREATE TYPE "public"."purge_data_category" AS ENUM('account', 'authentication', 'interview', 'message', 'evaluation', 'operation', 'report');--> statement-breakpoint
CREATE TYPE "public"."purge_result" AS ENUM('succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."question_difficulty" AS ENUM('medium');--> statement-breakpoint
CREATE TYPE "public"."question_outcome_kind" AS ENUM('scored', 'incorrect', 'unknown', 'skipped', 'irrelevant');--> statement-breakpoint
CREATE TYPE "public"."report_kind" AS ENUM('complete', 'incomplete');--> statement-breakpoint
CREATE TYPE "public"."response_classification" AS ENUM('relevant', 'ambiguous', 'irrelevant');--> statement-breakpoint
CREATE TYPE "public"."zero_score_reason" AS ENUM('unknown', 'skipped', 'irrelevant', 'incorrect');--> statement-breakpoint
CREATE TABLE "deletion_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"scope" "deletion_scope" NOT NULL,
	"interview_id" text,
	"status" "deletion_status" DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inaccessible_at" timestamp with time zone DEFAULT now() NOT NULL,
	"purge_due_at" timestamp with time zone NOT NULL,
	"processing_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"result" jsonb,
	"error" jsonb,
	CONSTRAINT "deletion_requests_due_within_seven_days_check" CHECK ("deletion_requests"."purge_due_at" >= "deletion_requests"."requested_at" and "deletion_requests"."purge_due_at" <= "deletion_requests"."requested_at" + interval '7 days'),
	CONSTRAINT "deletion_requests_scope_target_check" CHECK (("deletion_requests"."scope" = 'account' and "deletion_requests"."interview_id" is null) or ("deletion_requests"."scope" = 'interview' and "deletion_requests"."interview_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "interview_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"question_snapshot_id" text,
	"question_position" smallint,
	"role" "interview_message_role" NOT NULL,
	"kind" "interview_message_kind" NOT NULL,
	"answer_material_kind" "answer_material_kind",
	"content" text NOT NULL,
	"operation_id" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interview_messages_question_position_check" CHECK ("interview_messages"."question_position" is null or "interview_messages"."question_position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "interview_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"direction" "interview_direction" DEFAULT 'go_backend' NOT NULL,
	"selected_question_count" smallint NOT NULL,
	"selection_seed" text NOT NULL,
	"status" "interview_status" DEFAULT 'active' NOT NULL,
	"active_phase" "interview_phase" DEFAULT 'awaiting_response',
	"version" integer DEFAULT 1 NOT NULL,
	"current_question_position" smallint DEFAULT 1 NOT NULL,
	"pending_operation_kind" "pending_interview_operation_kind",
	"pending_operation_question_position" smallint,
	"pending_operation_accepted_at" timestamp with time zone,
	"pending_operation_previous_phase" "interview_phase",
	"pending_report_kind" "report_kind",
	"report_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_effective_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"deletion_requested_at" timestamp with time zone,
	CONSTRAINT "interview_sessions_id_owner_fk_target_unique" UNIQUE("id","owner_user_id"),
	CONSTRAINT "interview_sessions_selected_question_count_check" CHECK ("interview_sessions"."selected_question_count" in (5, 10, 15)),
	CONSTRAINT "interview_sessions_version_check" CHECK ("interview_sessions"."version" >= 1),
	CONSTRAINT "interview_sessions_current_position_check" CHECK ("interview_sessions"."current_question_position" >= 1)
);
--> statement-breakpoint
CREATE TABLE "operations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"interview_id" text NOT NULL,
	"idempotency_scope" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"type" "operation_type" NOT NULL,
	"status" "operation_status" DEFAULT 'pending' NOT NULL,
	"expected_version" integer NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"lease_acquired_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"input" jsonb NOT NULL,
	"result" jsonb,
	"error" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "operations_id_interview_fk_target_unique" UNIQUE("id","interview_id"),
	CONSTRAINT "operations_expected_version_check" CHECK ("operations"."expected_version" >= 0),
	CONSTRAINT "operations_attempt_count_check" CHECK ("operations"."attempt_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "purge_audit_events" (
	"subject_identifier_hash" text NOT NULL,
	"data_category" "purge_data_category" NOT NULL,
	"result" "purge_result" NOT NULL,
	"purged_at" timestamp with time zone NOT NULL,
	CONSTRAINT "purge_audit_events_pk" PRIMARY KEY("subject_identifier_hash","data_category","purged_at")
);
--> statement-breakpoint
CREATE TABLE "question_bank_versions" (
	"question_id" text NOT NULL,
	"content_version" integer NOT NULL,
	"domain" "knowledge_domain" NOT NULL,
	"difficulty" "question_difficulty" DEFAULT 'medium' NOT NULL,
	"source_wording" text NOT NULL,
	"rubric" jsonb NOT NULL,
	"follow_up_goals" jsonb NOT NULL,
	"knowledge_explanation" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"reviewed" boolean DEFAULT false NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" text,
	"import_source_name" text NOT NULL,
	"import_source_version" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_bank_versions_pk" PRIMARY KEY("question_id","content_version"),
	CONSTRAINT "question_bank_versions_content_version_check" CHECK ("question_bank_versions"."content_version" >= 1)
);
--> statement-breakpoint
CREATE TABLE "question_evaluations" (
	"id" text PRIMARY KEY NOT NULL,
	"question_snapshot_id" text NOT NULL,
	"classification" "response_classification" NOT NULL,
	"rubric_results" jsonb NOT NULL,
	"outcome_kind" "evaluation_outcome_kind" NOT NULL,
	"score" smallint NOT NULL,
	"zero_score_reason" "zero_score_reason",
	"model_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_evaluations_outcome_integrity_check" CHECK (
        (
          (
            "question_evaluations"."outcome_kind" = 'scored'
            and "question_evaluations"."classification" in ('relevant', 'ambiguous')
            and "question_evaluations"."score" between 1 and 100
            and "question_evaluations"."zero_score_reason" is null
          )
          or (
            "question_evaluations"."outcome_kind" = 'incorrect'
            and "question_evaluations"."classification" in ('relevant', 'ambiguous')
            and "question_evaluations"."score" = 0
            and "question_evaluations"."zero_score_reason" = 'incorrect'
          )
          or (
            "question_evaluations"."outcome_kind" = 'irrelevant'
            and "question_evaluations"."classification" = 'irrelevant'
            and "question_evaluations"."score" = 0
            and "question_evaluations"."zero_score_reason" = 'irrelevant'
          )
        ) is true
      )
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" "report_kind" NOT NULL,
	"schema_version" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"model_metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_question_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"interview_id" text NOT NULL,
	"position" smallint NOT NULL,
	"source_question_id" text NOT NULL,
	"source_question_version" integer NOT NULL,
	"domain" "knowledge_domain" NOT NULL,
	"source_wording" text NOT NULL,
	"display_wording" text NOT NULL,
	"rubric" jsonb NOT NULL,
	"follow_up_goals" jsonb NOT NULL,
	"knowledge_explanation" text NOT NULL,
	"frozen" boolean DEFAULT false NOT NULL,
	"outcome_kind" "question_outcome_kind",
	"score" smallint,
	"zero_score_reason" "zero_score_reason",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"frozen_at" timestamp with time zone,
	CONSTRAINT "session_question_snapshots_id_interview_fk_target_unique" UNIQUE("id","interview_id"),
	CONSTRAINT "session_question_snapshots_position_check" CHECK ("session_question_snapshots"."position" >= 1),
	CONSTRAINT "session_question_snapshots_source_version_check" CHECK ("session_question_snapshots"."source_question_version" >= 1),
	CONSTRAINT "session_question_snapshots_outcome_integrity_check" CHECK (
        (
          ("session_question_snapshots"."outcome_kind" is null and "session_question_snapshots"."score" is null and "session_question_snapshots"."zero_score_reason" is null)
          or (
            "session_question_snapshots"."outcome_kind" = 'scored'
            and "session_question_snapshots"."score" between 1 and 100
            and "session_question_snapshots"."zero_score_reason" is null
          )
          or (
            "session_question_snapshots"."outcome_kind" = 'incorrect'
            and "session_question_snapshots"."score" = 0
            and "session_question_snapshots"."zero_score_reason" = 'incorrect'
          )
          or (
            "session_question_snapshots"."outcome_kind" = 'irrelevant'
            and "session_question_snapshots"."score" = 0
            and "session_question_snapshots"."zero_score_reason" = 'irrelevant'
          )
          or (
            "session_question_snapshots"."outcome_kind" = 'unknown'
            and "session_question_snapshots"."score" = 0
            and "session_question_snapshots"."zero_score_reason" = 'unknown'
          )
          or (
            "session_question_snapshots"."outcome_kind" = 'skipped'
            and "session_question_snapshots"."score" = 0
            and "session_question_snapshots"."zero_score_reason" = 'skipped'
          )
        ) is true
      )
);
--> statement-breakpoint
ALTER TABLE "user" ALTER COLUMN "deletion_requested_at" SET DATA TYPE timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_interview_owner_fk" FOREIGN KEY ("interview_id","owner_user_id") REFERENCES "public"."interview_sessions"("id","owner_user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_messages" ADD CONSTRAINT "interview_messages_interview_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interview_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_messages" ADD CONSTRAINT "interview_messages_snapshot_aggregate_fk" FOREIGN KEY ("question_snapshot_id","interview_id") REFERENCES "public"."session_question_snapshots"("id","interview_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_messages" ADD CONSTRAINT "interview_messages_operation_aggregate_fk" FOREIGN KEY ("operation_id","interview_id") REFERENCES "public"."operations"("id","interview_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_interview_owner_fk" FOREIGN KEY ("interview_id","owner_user_id") REFERENCES "public"."interview_sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_evaluations" ADD CONSTRAINT "question_evaluations_question_snapshot_id_session_question_snapshots_id_fk" FOREIGN KEY ("question_snapshot_id") REFERENCES "public"."session_question_snapshots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_interview_owner_fk" FOREIGN KEY ("interview_id","owner_user_id") REFERENCES "public"."interview_sessions"("id","owner_user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_question_snapshots" ADD CONSTRAINT "session_question_snapshots_interview_id_interview_sessions_id_fk" FOREIGN KEY ("interview_id") REFERENCES "public"."interview_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_question_snapshots" ADD CONSTRAINT "session_question_snapshots_source_question_fk" FOREIGN KEY ("source_question_id","source_question_version") REFERENCES "public"."question_bank_versions"("question_id","content_version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deletion_requests_owner_user_idx" ON "deletion_requests" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "deletion_requests_interview_idx" ON "deletion_requests" USING btree ("interview_id");--> statement-breakpoint
CREATE INDEX "deletion_requests_status_due_idx" ON "deletion_requests" USING btree ("status","purge_due_at");--> statement-breakpoint
CREATE INDEX "interview_messages_interview_position_idx" ON "interview_messages" USING btree ("interview_id","question_position");--> statement-breakpoint
CREATE INDEX "interview_messages_operation_idx" ON "interview_messages" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "interview_sessions_owner_user_idx" ON "interview_sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "interview_sessions_status_idx" ON "interview_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "interview_sessions_last_activity_idx" ON "interview_sessions" USING btree ("last_effective_activity_at");--> statement-breakpoint
CREATE INDEX "operations_owner_user_idx" ON "operations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "operations_interview_idx" ON "operations" USING btree ("interview_id");--> statement-breakpoint
CREATE INDEX "operations_status_lease_idx" ON "operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "purge_audit_events_subject_hash_idx" ON "purge_audit_events" USING btree ("subject_identifier_hash");--> statement-breakpoint
CREATE INDEX "purge_audit_events_purged_at_idx" ON "purge_audit_events" USING btree ("purged_at");--> statement-breakpoint
CREATE INDEX "question_bank_versions_domain_idx" ON "question_bank_versions" USING btree ("domain");--> statement-breakpoint
CREATE INDEX "question_bank_versions_active_reviewed_idx" ON "question_bank_versions" USING btree ("active","reviewed");--> statement-breakpoint
CREATE INDEX "question_evaluations_snapshot_idx" ON "question_evaluations" USING btree ("question_snapshot_id");--> statement-breakpoint
CREATE INDEX "reports_interview_idx" ON "reports" USING btree ("interview_id");--> statement-breakpoint
CREATE INDEX "reports_owner_user_idx" ON "reports" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "session_question_snapshots_interview_idx" ON "session_question_snapshots" USING btree ("interview_id");--> statement-breakpoint
CREATE INDEX "session_question_snapshots_source_idx" ON "session_question_snapshots" USING btree ("source_question_id","source_question_version");