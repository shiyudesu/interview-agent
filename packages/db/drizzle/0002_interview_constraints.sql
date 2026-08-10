LOCK TABLE "interview_sessions", "session_question_snapshots", "operations" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "interview_sessions" DROP CONSTRAINT "interview_sessions_current_position_check";--> statement-breakpoint
ALTER TABLE "operations" ALTER COLUMN "idempotency_scope" SET DATA TYPE "public"."operation_type" USING "idempotency_scope"::"public"."operation_type";--> statement-breakpoint
CREATE UNIQUE INDEX "interview_sessions_one_open_per_user_idx" ON "interview_sessions" USING btree ("owner_user_id") WHERE "interview_sessions"."status" in ('active', 'report_pending');--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_owner_scope_idempotency_unique" UNIQUE("owner_user_id","idempotency_scope","idempotency_key");--> statement-breakpoint
ALTER TABLE "session_question_snapshots" ADD CONSTRAINT "session_question_snapshots_interview_position_unique" UNIQUE("interview_id","position");--> statement-breakpoint
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_current_position_check" CHECK ("interview_sessions"."current_question_position" between 1 and "interview_sessions"."selected_question_count");--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_idempotency_scope_check" CHECK ("operations"."idempotency_scope" = "operations"."type");--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_status_lease_check" CHECK (
        (
          "operations"."status" = 'processing'
          and "operations"."lease_acquired_at" is not null
          and "operations"."lease_expires_at" is not null
          and "operations"."lease_expires_at" > "operations"."lease_acquired_at"
        )
        or (
          "operations"."status" <> 'processing'
          and "operations"."lease_acquired_at" is null
          and "operations"."lease_expires_at" is null
        )
      );--> statement-breakpoint
CREATE FUNCTION "assert_interview_blueprint_complete"("target_interview_id" text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  expected_count smallint;
  actual_count bigint;
  minimum_position smallint;
  maximum_position smallint;
BEGIN
  SELECT selected_question_count
    INTO expected_count
    FROM interview_sessions
   WHERE id = target_interview_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT count(*), min(position), max(position)
    INTO actual_count, minimum_position, maximum_position
    FROM session_question_snapshots
   WHERE interview_id = target_interview_id;

  IF actual_count <> expected_count
     OR minimum_position <> 1
     OR maximum_position <> expected_count THEN
    RAISE EXCEPTION
      'interview % requires contiguous question positions 1..%, found count %, min %, max %',
      target_interview_id,
      expected_count,
      actual_count,
      minimum_position,
      maximum_position
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_question_snapshots_complete_blueprint_check';
  END IF;
END;
$$;--> statement-breakpoint
DO $$
DECLARE
  interview_record record;
BEGIN
  FOR interview_record IN
    SELECT id
      FROM interview_sessions
     ORDER BY id
  LOOP
    PERFORM assert_interview_blueprint_complete(interview_record.id);
  END LOOP;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "check_interview_blueprint_from_session"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_interview_blueprint_complete(NEW.id);
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "check_interview_blueprint_from_snapshot"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM assert_interview_blueprint_complete(OLD.interview_id);
  ELSE
    PERFORM assert_interview_blueprint_complete(NEW.interview_id);
    IF TG_OP = 'UPDATE' AND OLD.interview_id IS DISTINCT FROM NEW.interview_id THEN
      PERFORM assert_interview_blueprint_complete(OLD.interview_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "interview_sessions_complete_blueprint_trigger"
AFTER INSERT OR UPDATE ON "interview_sessions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "check_interview_blueprint_from_session"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "session_question_snapshots_complete_blueprint_trigger"
AFTER INSERT OR UPDATE OR DELETE ON "session_question_snapshots"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "check_interview_blueprint_from_snapshot"();--> statement-breakpoint
CREATE FUNCTION "prevent_interview_blueprint_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.owner_user_id,
    OLD.direction,
    OLD.selected_question_count,
    OLD.selection_seed
  ) IS DISTINCT FROM ROW(
    NEW.owner_user_id,
    NEW.direction,
    NEW.selected_question_count,
    NEW.selection_seed
  ) THEN
    RAISE EXCEPTION 'interview blueprint ownership and selection are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'interview_sessions_immutable_blueprint_check';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "interview_sessions_immutable_blueprint_trigger"
BEFORE UPDATE ON "interview_sessions"
FOR EACH ROW
EXECUTE FUNCTION "prevent_interview_blueprint_update"();--> statement-breakpoint
CREATE FUNCTION "prevent_session_question_snapshot_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.interview_id,
    OLD.position,
    OLD.source_question_id,
    OLD.source_question_version,
    OLD.domain,
    OLD.source_wording,
    OLD.display_wording,
    OLD.rubric,
    OLD.follow_up_goals,
    OLD.knowledge_explanation,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.interview_id,
    NEW.position,
    NEW.source_question_id,
    NEW.source_question_version,
    NEW.domain,
    NEW.source_wording,
    NEW.display_wording,
    NEW.rubric,
    NEW.follow_up_goals,
    NEW.knowledge_explanation,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'session question snapshot identity and content are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_question_snapshots_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "session_question_snapshots_immutable_trigger"
BEFORE UPDATE ON "session_question_snapshots"
FOR EACH ROW
EXECUTE FUNCTION "prevent_session_question_snapshot_identity_update"();--> statement-breakpoint
CREATE FUNCTION "prevent_session_question_snapshot_delete_while_interview_exists"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM interview_sessions
     WHERE id = OLD.interview_id
  ) THEN
    RAISE EXCEPTION 'session question snapshots cannot be deleted while their interview exists'
      USING ERRCODE = '23514',
            CONSTRAINT = 'session_question_snapshots_immutable_delete_check';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "session_question_snapshots_immutable_delete_trigger"
BEFORE DELETE ON "session_question_snapshots"
FOR EACH ROW
EXECUTE FUNCTION "prevent_session_question_snapshot_delete_while_interview_exists"();--> statement-breakpoint
CREATE FUNCTION "prevent_operation_identity_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    OLD.id,
    OLD.owner_user_id,
    OLD.interview_id,
    OLD.idempotency_scope,
    OLD.idempotency_key,
    OLD.type,
    OLD.expected_version,
    OLD.input,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.id,
    NEW.owner_user_id,
    NEW.interview_id,
    NEW.idempotency_scope,
    NEW.idempotency_key,
    NEW.type,
    NEW.expected_version,
    NEW.input,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'operation identity and command input are immutable'
      USING ERRCODE = '23514',
            CONSTRAINT = 'operations_immutable_input_check';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "operations_immutable_input_trigger"
BEFORE UPDATE ON "operations"
FOR EACH ROW
EXECUTE FUNCTION "prevent_operation_identity_update"();--> statement-breakpoint
CREATE FUNCTION "prevent_operation_delete_while_interview_exists"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM interview_sessions
     WHERE id = OLD.interview_id
  ) THEN
    RAISE EXCEPTION 'operations cannot be deleted while their interview exists'
      USING ERRCODE = '23514',
            CONSTRAINT = 'operations_immutable_input_delete_check';
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "operations_immutable_input_delete_trigger"
BEFORE DELETE ON "operations"
FOR EACH ROW
EXECUTE FUNCTION "prevent_operation_delete_while_interview_exists"();