LOCK TABLE "session" IN EXCLUSIVE MODE;--> statement-breakpoint
DELETE FROM "session" AS session_row
USING "user" AS account_owner
WHERE session_row."user_id" = account_owner."id"
  AND account_owner."deletion_requested_at" IS NOT NULL;--> statement-breakpoint
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
  );