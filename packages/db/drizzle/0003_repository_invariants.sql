DROP INDEX "question_evaluations_snapshot_idx";--> statement-breakpoint
DROP INDEX "reports_interview_idx";--> statement-breakpoint
ALTER TABLE "interview_messages" ADD COLUMN "sequence" integer;--> statement-breakpoint
WITH "ranked_messages" AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "interview_id"
      ORDER BY "created_at", "id"
    )::integer AS "sequence"
  FROM "interview_messages"
)
UPDATE "interview_messages"
SET "sequence" = "ranked_messages"."sequence"
FROM "ranked_messages"
WHERE "interview_messages"."id" = "ranked_messages"."id";--> statement-breakpoint
ALTER TABLE "interview_messages" ALTER COLUMN "sequence" SET NOT NULL;--> statement-breakpoint
LOCK TABLE "interview_sessions", "operations" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD COLUMN "pending_operation_id" text;--> statement-breakpoint
DO $$
DECLARE
  invalid_interview record;
BEGIN
  SELECT
    "interview_sessions"."id",
    0::bigint AS "matching_operation_count"
  INTO invalid_interview
  FROM "interview_sessions"
  WHERE (
    "interview_sessions"."status" = 'active'
    AND "interview_sessions"."active_phase" = 'processing'
    AND "interview_sessions"."pending_operation_kind" IS NOT NULL
    AND "interview_sessions"."pending_operation_question_position" IS NOT NULL
    AND "interview_sessions"."pending_operation_accepted_at" IS NOT NULL
    AND "interview_sessions"."pending_operation_previous_phase"
          IN ('awaiting_response', 'awaiting_continue')
  ) IS NOT TRUE
    AND (
      "interview_sessions"."active_phase" = 'processing'
      OR "interview_sessions"."pending_operation_kind" IS NOT NULL
      OR "interview_sessions"."pending_operation_question_position" IS NOT NULL
      OR "interview_sessions"."pending_operation_accepted_at" IS NOT NULL
      OR "interview_sessions"."pending_operation_previous_phase" IS NOT NULL
    )
  ORDER BY "interview_sessions"."id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cannot backfill pending_operation_id for interview %: processing state lacks complete pending metadata',
      invalid_interview.id;
  END IF;

  SELECT
    "interview_sessions"."id",
    count("operations"."id") AS "matching_operation_count"
  INTO invalid_interview
  FROM "interview_sessions"
  LEFT JOIN "operations"
    ON "operations"."interview_id" = "interview_sessions"."id"
   AND "operations"."owner_user_id" = "interview_sessions"."owner_user_id"
   AND "operations"."status" = 'processing'
   AND "operations"."expected_version" = "interview_sessions"."version" - 1
   AND "operations"."created_at" = "interview_sessions"."pending_operation_accepted_at"
   AND "operations"."input" -> 'questionPosition'
         = to_jsonb("interview_sessions"."pending_operation_question_position")
   AND (
     (
       "interview_sessions"."pending_operation_kind" = 'question_clarification'
       AND "interview_sessions"."pending_operation_previous_phase" = 'awaiting_response'
       AND "operations"."type" = 'request_question_clarification'
       AND "operations"."idempotency_scope" = 'request_question_clarification'
     )
     OR (
       "interview_sessions"."pending_operation_kind" = 'answer_analysis'
       AND "interview_sessions"."pending_operation_previous_phase" = 'awaiting_response'
       AND "operations"."type" = 'submit_answer'
       AND "operations"."idempotency_scope" = 'submit_answer'
     )
     OR (
       "interview_sessions"."pending_operation_kind" = 'answer_analysis'
       AND "interview_sessions"."pending_operation_previous_phase" = 'awaiting_continue'
       AND "operations"."type" = 'submit_supplement'
       AND "operations"."idempotency_scope" = 'submit_supplement'
     )
   )
  WHERE (
    "interview_sessions"."pending_operation_kind" IS NOT NULL
    OR "interview_sessions"."pending_operation_question_position" IS NOT NULL
    OR "interview_sessions"."pending_operation_accepted_at" IS NOT NULL
    OR "interview_sessions"."pending_operation_previous_phase" IS NOT NULL
  )
    AND "interview_sessions"."status" = 'active'
    AND "interview_sessions"."active_phase" = 'processing'
    AND "interview_sessions"."version" >= 2
    AND "interview_sessions"."current_question_position"
          = "interview_sessions"."pending_operation_question_position"
    AND "interview_sessions"."last_effective_activity_at"
          = "interview_sessions"."pending_operation_accepted_at"
  GROUP BY "interview_sessions"."id"
  HAVING count("operations"."id") <> 1
  ORDER BY "interview_sessions"."id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cannot backfill pending_operation_id for interview %: expected exactly one matching processing Operation, found %',
      invalid_interview.id,
      invalid_interview.matching_operation_count;
  END IF;

  SELECT
    "interview_sessions"."id",
    0::bigint AS "matching_operation_count"
  INTO invalid_interview
  FROM "interview_sessions"
  WHERE "interview_sessions"."status" = 'active'
    AND "interview_sessions"."active_phase" = 'processing'
    AND (
      "interview_sessions"."version" >= 2
      AND "interview_sessions"."current_question_position"
            = "interview_sessions"."pending_operation_question_position"
      AND "interview_sessions"."last_effective_activity_at"
            = "interview_sessions"."pending_operation_accepted_at"
    ) IS NOT TRUE
  ORDER BY "interview_sessions"."id"
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION
      'cannot backfill pending_operation_id for interview %: pending metadata is inconsistent with processing state',
      invalid_interview.id;
  END IF;

END;
$$;--> statement-breakpoint
UPDATE "interview_sessions"
SET "pending_operation_id" = (
  SELECT "operations"."id"
  FROM "operations"
  WHERE "operations"."interview_id" = "interview_sessions"."id"
    AND "operations"."owner_user_id" = "interview_sessions"."owner_user_id"
    AND "operations"."status" = 'processing'
    AND "operations"."expected_version" = "interview_sessions"."version" - 1
    AND "operations"."created_at" = "interview_sessions"."pending_operation_accepted_at"
    AND "operations"."input" -> 'questionPosition'
          = to_jsonb("interview_sessions"."pending_operation_question_position")
    AND (
      (
        "interview_sessions"."pending_operation_kind" = 'question_clarification'
        AND "interview_sessions"."pending_operation_previous_phase" = 'awaiting_response'
        AND "operations"."type" = 'request_question_clarification'
        AND "operations"."idempotency_scope" = 'request_question_clarification'
      )
      OR (
        "interview_sessions"."pending_operation_kind" = 'answer_analysis'
        AND "interview_sessions"."pending_operation_previous_phase" = 'awaiting_response'
        AND "operations"."type" = 'submit_answer'
        AND "operations"."idempotency_scope" = 'submit_answer'
      )
      OR (
        "interview_sessions"."pending_operation_kind" = 'answer_analysis'
        AND "interview_sessions"."pending_operation_previous_phase" = 'awaiting_continue'
        AND "operations"."type" = 'submit_supplement'
        AND "operations"."idempotency_scope" = 'submit_supplement'
      )
    )
)
WHERE (
  "interview_sessions"."pending_operation_kind" IS NOT NULL
  OR "interview_sessions"."pending_operation_question_position" IS NOT NULL
  OR "interview_sessions"."pending_operation_accepted_at" IS NOT NULL
  OR "interview_sessions"."pending_operation_previous_phase" IS NOT NULL
);--> statement-breakpoint
SET CONSTRAINTS ALL IMMEDIATE;--> statement-breakpoint
ALTER TABLE "interview_messages" ADD CONSTRAINT "interview_messages_interview_sequence_unique" UNIQUE("interview_id","sequence");--> statement-breakpoint
ALTER TABLE "question_evaluations" ADD CONSTRAINT "question_evaluations_snapshot_unique" UNIQUE("question_snapshot_id");--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_interview_unique" UNIQUE("interview_id");--> statement-breakpoint
ALTER TABLE "interview_messages" ADD CONSTRAINT "interview_messages_sequence_check" CHECK ("interview_messages"."sequence" > 0);--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_pending_operation_check" CHECK (
        (
          "interview_sessions"."active_phase" is distinct from 'processing'
          and "interview_sessions"."pending_operation_id" is null
          and "interview_sessions"."pending_operation_kind" is null
          and "interview_sessions"."pending_operation_question_position" is null
          and "interview_sessions"."pending_operation_accepted_at" is null
          and "interview_sessions"."pending_operation_previous_phase" is null
        )
        or (
          "interview_sessions"."status" = 'active'
          and "interview_sessions"."active_phase" = 'processing'
          and "interview_sessions"."pending_operation_id" is not null
          and "interview_sessions"."pending_operation_kind" is not null
          and "interview_sessions"."pending_operation_question_position" is not null
          and "interview_sessions"."pending_operation_accepted_at" is not null
          and "interview_sessions"."pending_operation_previous_phase" in ('awaiting_response', 'awaiting_continue')
        )
      );