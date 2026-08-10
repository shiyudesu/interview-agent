CREATE TYPE "public"."question_type" AS ENUM('conceptual', 'scenario', 'design', 'troubleshooting');--> statement-breakpoint
ALTER TABLE "question_bank_versions" ADD COLUMN "question_type" "question_type" DEFAULT 'conceptual' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank_versions" ADD COLUMN "source_active" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank_versions" ADD COLUMN "source_schema_version" text DEFAULT '1.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank_versions" ADD COLUMN "import_source_file" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_bank_versions" ADD COLUMN "source_hash" text;--> statement-breakpoint
LOCK TABLE "question_bank_versions" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
UPDATE "question_bank_versions"
SET "source_active" = "active";--> statement-breakpoint
WITH latest_versions AS (
	SELECT "question_id", max("content_version") AS "content_version"
	FROM "question_bank_versions"
	GROUP BY "question_id"
)
UPDATE "question_bank_versions" AS versions
SET "active" = (
	versions."content_version" = latest_versions."content_version"
	AND versions."source_active"
	AND versions."reviewed"
)
FROM latest_versions
WHERE versions."question_id" = latest_versions."question_id";--> statement-breakpoint
CREATE FUNCTION "question_bank_json_key_sort_key"("value" text)
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
CREATE FUNCTION "question_bank_canonical_json_number"("value" jsonb)
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
    RAISE EXCEPTION 'Question-bank content contains a non-finite JSON number';
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
CREATE FUNCTION "question_bank_canonical_json"("value" jsonb)
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
          to_jsonb(object_key)::text || ':' || "question_bank_canonical_json"("value" -> object_key),
          ','
          ORDER BY "question_bank_json_key_sort_key"(object_key)
        ),
        ''
      )
      INTO canonical_body
      FROM jsonb_object_keys("value") AS object_keys(object_key);
      RETURN '{' || canonical_body || '}';
    WHEN 'array' THEN
      SELECT coalesce(
        string_agg("question_bank_canonical_json"(array_value), ',' ORDER BY ordinal),
        ''
      )
      INTO canonical_body
      FROM jsonb_array_elements("value") WITH ORDINALITY AS array_items(array_value, ordinal);
      RETURN '[' || canonical_body || ']';
    WHEN 'number' THEN
      RETURN "question_bank_canonical_json_number"("value");
    ELSE
      RETURN "value"::text;
  END CASE;
END;
$$;--> statement-breakpoint
UPDATE "question_bank_versions"
SET "source_hash" = encode(
	sha256(
		convert_to(
			"question_bank_canonical_json"(
				jsonb_build_object(
					'questionId', "question_id",
					'contentVersion', "content_version",
					'domain', "domain",
					'difficulty', "difficulty",
					'questionType', "question_type",
					'sourceWording', "source_wording",
					'rubric', "rubric",
					'followUpGoals', "follow_up_goals",
					'knowledgeExplanation', "knowledge_explanation",
					'sourceActive', "source_active",
					'reviewed', "reviewed",
					'reviewedAt', CASE
						WHEN "reviewed_at" IS NULL THEN NULL
						ELSE to_char(
							"reviewed_at" AT TIME ZONE 'UTC',
							'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
						)
					END,
					'reviewedBy', "reviewed_by",
					'importSourceName', "import_source_name",
					'importSourceVersion', "import_source_version",
					'sourceSchemaVersion', "source_schema_version",
					'importSourceFile', "import_source_file"
				)
			),
			'UTF8'
		)
	),
	'hex'
);--> statement-breakpoint
ALTER TABLE "question_bank_versions" ALTER COLUMN "source_hash" SET NOT NULL;--> statement-breakpoint
DROP FUNCTION "question_bank_canonical_json"(jsonb);--> statement-breakpoint
DROP FUNCTION "question_bank_canonical_json_number"(jsonb);--> statement-breakpoint
DROP FUNCTION "question_bank_json_key_sort_key"(text);--> statement-breakpoint
CREATE UNIQUE INDEX "question_bank_versions_one_active_question_idx" ON "question_bank_versions" USING btree ("question_id") WHERE "question_bank_versions"."active";--> statement-breakpoint
ALTER TABLE "question_bank_versions" ADD CONSTRAINT "question_bank_versions_active_eligibility_check" CHECK (not "question_bank_versions"."active" or ("question_bank_versions"."source_active" and "question_bank_versions"."reviewed"));--> statement-breakpoint
ALTER TABLE "question_bank_versions" ADD CONSTRAINT "question_bank_versions_source_hash_check" CHECK ("question_bank_versions"."source_hash" ~ '^[0-9a-f]{64}$' and "question_bank_versions"."source_hash" <> repeat('0', 64));
