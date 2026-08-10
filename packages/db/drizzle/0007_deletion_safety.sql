ALTER TABLE "deletion_requests" DROP CONSTRAINT "deletion_requests_due_within_seven_days_check";--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD COLUMN "purge_deadline_at" timestamp with time zone;--> statement-breakpoint
UPDATE "deletion_requests"
SET
  "purge_due_at" = greatest(
    "requested_at",
    least("purge_due_at", "requested_at" + interval '6 days')
  ),
  "purge_deadline_at" = "requested_at" + interval '7 days';--> statement-breakpoint
ALTER TABLE "deletion_requests" ALTER COLUMN "purge_deadline_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_requests" ADD CONSTRAINT "deletion_requests_purge_window_check" CHECK (
  "deletion_requests"."purge_due_at" >= "deletion_requests"."requested_at"
  and "deletion_requests"."purge_due_at" < "deletion_requests"."purge_deadline_at"
  and "deletion_requests"."purge_deadline_at" = "deletion_requests"."requested_at" + interval '7 days'
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION safe_verification_value_jsonb(value text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
STRICT
AS $$
BEGIN
  RETURN value::jsonb;
EXCEPTION
  WHEN data_exception THEN
    RETURN NULL;
END;
$$;--> statement-breakpoint
DELETE FROM "verification" AS verification_row
USING "user" AS account_owner
WHERE account_owner."deletion_requested_at" IS NOT NULL
  AND (
    verification_row."identifier" = 'email-verification-otp-' || account_owner."email"
    OR verification_row."identifier" = 'sign-in-otp-' || account_owner."email"
    OR verification_row."identifier" = 'forget-password-otp-' || account_owner."email"
    OR starts_with(
      verification_row."identifier",
      'change-email-otp-' || account_owner."email" || '-'
    )
    OR safe_verification_value_jsonb(verification_row."value") #>> '{link,userId}'
      = account_owner."id"
    OR safe_verification_value_jsonb(verification_row."value") #>> '{link,email}'
      = account_owner."email"
  );--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_session_for_deleting_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  account_deletion_requested_at timestamp with time zone;
BEGIN
  SELECT "deletion_requested_at"
    INTO account_deletion_requested_at
    FROM "user"
   WHERE "id" = NEW."user_id"
   FOR UPDATE;

  IF FOUND AND account_deletion_requested_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot issue a session for a deletion-marked account'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'session_user_not_deleting_check';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER session_user_not_deleting_trigger
BEFORE INSERT OR UPDATE ON "session"
FOR EACH ROW
EXECUTE FUNCTION reject_session_for_deleting_user();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_verification_for_deleting_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate_identifiers text[] := ARRAY[NEW."identifier"];
  candidate_values text[] := ARRAY[NEW."value"];
  candidate_link_user_ids text[] := ARRAY[]::text[];
  matched_user_ids text[] := ARRAY[]::text[];
  account_owner record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    candidate_identifiers := candidate_identifiers || OLD."identifier";
    candidate_values := candidate_values || OLD."value";
  END IF;

  SELECT coalesce(array_agg(DISTINCT candidate."link_user_id"), ARRAY[]::text[])
    INTO candidate_link_user_ids
    FROM (
      SELECT safe_verification_value_jsonb(candidate_value) #>> '{link,userId}'
        AS "link_user_id"
        FROM unnest(candidate_values) AS values_to_parse(candidate_value)
    ) AS candidate
   WHERE candidate."link_user_id" IS NOT NULL;

  FOR account_owner IN
    SELECT account_user."id", account_user."deletion_requested_at"
      FROM "user" AS account_user
     WHERE EXISTS (
       SELECT 1
         FROM unnest(candidate_identifiers, candidate_values)
           AS candidate("identifier", "value")
        WHERE candidate."identifier" = 'email-verification-otp-' || account_user."email"
           OR candidate."identifier" = 'sign-in-otp-' || account_user."email"
           OR candidate."identifier" = 'forget-password-otp-' || account_user."email"
           OR starts_with(
             candidate."identifier",
             'change-email-otp-' || account_user."email" || '-'
           )
           OR safe_verification_value_jsonb(candidate."value") #>> '{link,userId}'
             = account_user."id"
           OR safe_verification_value_jsonb(candidate."value") #>> '{link,email}'
             = account_user."email"
     )
     ORDER BY account_user."id"
     FOR UPDATE
  LOOP
    matched_user_ids := array_append(matched_user_ids, account_owner."id");
    IF account_owner."deletion_requested_at" IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot write verification data for a deletion-marked account'
        USING
          ERRCODE = '23514',
          CONSTRAINT = 'verification_user_not_deleting_check';
    END IF;
  END LOOP;

  IF EXISTS (
    SELECT 1
      FROM unnest(candidate_link_user_ids) AS linked_owner("user_id")
     WHERE NOT linked_owner."user_id" = ANY(matched_user_ids)
  ) THEN
    RAISE EXCEPTION 'Cannot write account-link state without an active account'
      USING
        ERRCODE = '23514',
        CONSTRAINT = 'verification_user_not_deleting_check';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER verification_user_not_deleting_trigger
BEFORE INSERT OR UPDATE ON "verification"
FOR EACH ROW
EXECUTE FUNCTION reject_verification_for_deleting_user();
