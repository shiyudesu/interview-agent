# Persist Operation leases in PostgreSQL

Persisted Operations use PostgreSQL compare-and-update transitions rather than process-local locks.
An idempotency identity is `(owner_user_id, idempotency_scope, idempotency_key)`, where the scope is
an explicit stable command scope and is not required to equal the command type. The command type,
interview, expected version, canonical safe-JSON input, and its SHA-256 fingerprint are immutable.
Reusing the identity with different command facts is an explicit idempotency conflict. Canonical JSON
recursively sorts object keys by JavaScript UTF-16 order, preserves array order, and uses
`JSON.stringify` primitive encodings; migration 0004 uses the same bytes for legacy backfill.

A pending Operation is claimed with one `UPDATE ... WHERE status = 'pending' RETURNING`. The claim
accepts only a bounded positive duration and an owner identity. PostgreSQL `statement_timestamp()`
sets acquisition, expiry, attempt, and update times. The repository generates a fresh
cryptographically random token, persists only its SHA-256 hash, increments the attempt count, and
returns the raw token plus exact attempt count only in the in-memory claim result. Attempts are
persisted without a database maximum; handlers decide their own bounds.

Retry is always explicit. A failed Operation can be claimed again only when its stored failure is
marked retryable and the supplied input is unchanged. A processing Operation can be reclaimed only
when `lease_expires_at < statement_timestamp()`; equality is still a live lease. Reclaim generates a
new token, replaces the lease identity, and increments the attempt count.

Completion requires the Operation ID, processing status, current owner, token hash, and exact attempt
count. Database statement time must still be within the lease, and that same database time becomes
`completed_at` and `updated_at`; callers cannot backdate completion. A delayed earlier attempt cannot
complete a later attempt even when the owner is reused. Completion atomically stores the validated
result or error, records whether a failure is retryable, and clears the active lease. A duplicate
completion from the same attempt and lease with the same payload returns the canonical terminal
Operation; another payload, attempt, or lease conflicts. Success is never retryable or overwritable.

Operation payloads must be bounded JSON objects with finite values and no credential-bearing keys.
Lease tokens are never stored or returned in raw form. Transaction-bound repositories let Operation
completion and interview/report writes commit or roll back in the same unit of work.
