CREATE FUNCTION "operation_json_key_sort_key"("value" text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  character_index integer;
  code_point integer;
  surrogate_value integer;
  sort_key text := '';
BEGIN
  IF char_length("value") = 0 THEN
    RETURN sort_key;
  END IF;
  FOR character_index IN 1..char_length("value") LOOP
    code_point := ascii(substr("value", character_index, 1));
    IF code_point <= 65535 THEN
      sort_key := sort_key || lpad(to_hex(code_point), 4, '0');
    ELSE
      surrogate_value := code_point - 65536;
      sort_key := sort_key
        || lpad(to_hex(55296 + (surrogate_value >> 10)), 4, '0')
        || lpad(to_hex(56320 + (surrogate_value & 1023)), 4, '0');
    END IF;
  END LOOP;
  RETURN sort_key;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "operation_canonical_json_number"("value" jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  raw_value text := lower((("value" #>> '{}')::double precision)::text);
  exponent_index integer;
  exponent_value integer;
  mantissa text;
  sign_prefix text := '';
  digits text;
  decimal_index integer;
  decimal_position integer;
BEGIN
  IF raw_value IN ('nan', 'infinity', '-infinity') THEN
    RAISE EXCEPTION 'Operation input contains a non-finite JSON number';
  END IF;
  exponent_index := strpos(raw_value, 'e');
  IF exponent_index = 0 THEN
    RETURN raw_value;
  END IF;
  mantissa := substr(raw_value, 1, exponent_index - 1);
  exponent_value := substr(raw_value, exponent_index + 1)::integer;
  IF exponent_value >= 21 OR exponent_value <= -7 THEN
    RETURN mantissa || 'e'
      || CASE WHEN exponent_value >= 0 THEN '+' ELSE '' END
      || exponent_value::text;
  END IF;
  IF left(mantissa, 1) = '-' THEN
    sign_prefix := '-';
    mantissa := substr(mantissa, 2);
  END IF;
  decimal_index := strpos(mantissa, '.');
  digits := replace(mantissa, '.', '');
  decimal_position :=
    CASE WHEN decimal_index = 0 THEN length(mantissa) ELSE decimal_index - 1 END
    + exponent_value;
  IF decimal_position <= 0 THEN
    RETURN sign_prefix || '0.' || repeat('0', -decimal_position) || digits;
  END IF;
  IF decimal_position >= length(digits) THEN
    RETURN sign_prefix || digits || repeat('0', decimal_position - length(digits));
  END IF;
  RETURN sign_prefix
    || substr(digits, 1, decimal_position)
    || '.'
    || substr(digits, decimal_position + 1);
END;
$$;--> statement-breakpoint
CREATE FUNCTION "operation_canonical_json"("value" jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  canonical_body text;
BEGIN
  CASE jsonb_typeof("value")
    WHEN 'object' THEN
      SELECT coalesce(
        string_agg(
          to_jsonb(object_key)::text || ':' || "operation_canonical_json"("value" -> object_key),
          ','
          ORDER BY "operation_json_key_sort_key"(object_key)
        ),
        ''
      )
      INTO canonical_body
      FROM jsonb_object_keys("value") AS object_keys(object_key);
      RETURN '{' || canonical_body || '}';
    WHEN 'array' THEN
      SELECT coalesce(
        string_agg("operation_canonical_json"(array_value), ',' ORDER BY ordinal),
        ''
      )
      INTO canonical_body
      FROM jsonb_array_elements("value") WITH ORDINALITY AS array_items(array_value, ordinal);
      RETURN '[' || canonical_body || ']';
    WHEN 'number' THEN
      RETURN "operation_canonical_json_number"("value");
    ELSE
      RETURN "value"::text;
  END CASE;
END;
$$;--> statement-breakpoint
LOCK TABLE "operations" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operations_idempotency_scope_check";--> statement-breakpoint
ALTER TABLE "operations" DROP CONSTRAINT "operations_status_lease_check";--> statement-breakpoint
ALTER TABLE "operations" ALTER COLUMN "idempotency_scope" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "lease_token_hash" text;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "completed_lease_owner" text;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "completed_lease_token_hash" text;--> statement-breakpoint
ALTER TABLE "operations" ADD COLUMN "retryable" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "operations"
SET
  "input_hash" = encode(
    sha256(convert_to("operation_canonical_json"("input"), 'UTF8')),
    'hex'
  ),
  "lease_owner" = CASE WHEN "status" = 'processing' THEN 'legacy-migration' END,
  "lease_token_hash" = CASE
    WHEN "status" = 'processing'
      THEN encode(sha256(convert_to('legacy-active:' || "id", 'UTF8')), 'hex')
  END,
  "completed_lease_owner" = CASE
    WHEN "status" IN ('succeeded', 'failed') THEN 'legacy-migration'
  END,
  "completed_lease_token_hash" = CASE
    WHEN "status" IN ('succeeded', 'failed')
      THEN encode(sha256(convert_to('legacy-completed:' || "id", 'UTF8')), 'hex')
  END;--> statement-breakpoint
ALTER TABLE "operations" ALTER COLUMN "input_hash" SET NOT NULL;--> statement-breakpoint
DROP FUNCTION "operation_canonical_json"(jsonb);--> statement-breakpoint
DROP FUNCTION "operation_canonical_json_number"(jsonb);--> statement-breakpoint
DROP FUNCTION "operation_json_key_sort_key"(text);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_operation_identity_update"()
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
    OLD.input_hash,
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
    NEW.input_hash,
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
ALTER TABLE "operations" ADD CONSTRAINT "operations_identity_hash_check" CHECK (
        length(trim("operations"."idempotency_scope")) > 0
        and length("operations"."input_hash") = 64
      );--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_lifecycle_check" CHECK (
        (
          "operations"."status" = 'processing'
          and "operations"."lease_acquired_at" is not null
          and "operations"."lease_expires_at" is not null
          and "operations"."lease_owner" is not null
          and "operations"."lease_token_hash" is not null
          and length(trim("operations"."lease_owner")) > 0
          and length("operations"."lease_token_hash") = 64
          and "operations"."lease_expires_at" > "operations"."lease_acquired_at"
          and "operations"."result" is null
          and "operations"."error" is null
          and "operations"."completed_at" is null
          and "operations"."completed_lease_owner" is null
          and "operations"."completed_lease_token_hash" is null
          and "operations"."retryable" = false
        )
        or (
          "operations"."status" = 'pending'
          and "operations"."lease_acquired_at" is null
          and "operations"."lease_expires_at" is null
          and "operations"."lease_owner" is null
          and "operations"."lease_token_hash" is null
          and "operations"."completed_lease_owner" is null
          and "operations"."completed_lease_token_hash" is null
          and "operations"."result" is null
          and "operations"."error" is null
          and "operations"."completed_at" is null
          and "operations"."retryable" = false
        )
        or (
          "operations"."status" = 'succeeded'
          and "operations"."lease_acquired_at" is null
          and "operations"."lease_expires_at" is null
          and "operations"."lease_owner" is null
          and "operations"."lease_token_hash" is null
          and "operations"."completed_lease_owner" is not null
          and "operations"."completed_lease_token_hash" is not null
          and length(trim("operations"."completed_lease_owner")) > 0
          and length("operations"."completed_lease_token_hash") = 64
          and "operations"."result" is not null
          and "operations"."error" is null
          and "operations"."completed_at" is not null
          and "operations"."retryable" = false
        )
        or (
          "operations"."status" = 'failed'
          and "operations"."lease_acquired_at" is null
          and "operations"."lease_expires_at" is null
          and "operations"."lease_owner" is null
          and "operations"."lease_token_hash" is null
          and "operations"."completed_lease_owner" is not null
          and "operations"."completed_lease_token_hash" is not null
          and length(trim("operations"."completed_lease_owner")) > 0
          and length("operations"."completed_lease_token_hash") = 64
          and "operations"."result" is null
          and "operations"."error" is not null
          and "operations"."completed_at" is not null
        )
      );