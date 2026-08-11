# Data lifecycle operations

## Interview expiry

Active interviews expire only when PostgreSQL evaluates
`statement_timestamp() - last_effective_activity_at > interval '24 hours'`. The exact 24-hour
boundary remains active. Protected aggregate and Operation reads/mutations run the same lazy check;
an expired row is atomically advanced to `abandoned`, its version is incremented, pending
Operation/report fields are cleared, open Operations are failed with a bounded lifecycle code, and
no report is created.

When a transaction-bound repository operation detects expiry, it aborts the caller's transaction
before persisting the expiry transition and Operation cancellation in a fresh root transaction.
Earlier unrelated writes therefore cannot commit with the expiry, and the caller receives the typed
expiry error only after the authoritative lifecycle transaction succeeds.

`LifecycleService.startPeriodicMaintenance()` runs the low-frequency in-process sweeper without an
external scheduler. Expiry batches use `FOR UPDATE SKIP LOCKED`; multiple application instances may
run it concurrently. Both the batch size and maximum batches per maintenance cycle are bounded
positive integers so invalid configuration cannot disable expiry or create an unbounded cycle. The
periodic interval is limited to 60,000 through 2,147,483,647 milliseconds so Node never truncates an
oversized timer into a one-millisecond loop.

## Deletion marking

`requestInterviewDeletion()` is owner-scoped and idempotent. It marks the interview `deleting`,
clears technical pending state, cancels open Operations, and creates one request due no later than
seven days after PostgreSQL's request time. Purge eligibility begins after six days, leaving a
one-day operational safety margin before the hard deadline at exactly `requested_at + 7 days`.

`requestAccountDeletion()` atomically locks all existing Better Auth session rows before the user
row, marks the user, deletes the sessions, marks every owned interview `deleting`, cancels open
Operations, and creates one account request. Session refresh follows the same session-row-then-user
lock order through the database trigger. A concurrent session insert either commits before the user
marker is acquired and is then deleted, or waits for the marker and is rejected. The workflow
deliberately does not invoke Better Auth hard deletion.

The forward migration chain also contains an idempotent cleanup for databases that had already
installed deletion write guards while legacy sessions still existed. It locks the session table
against concurrent writers and removes every session owned by a deletion-marked account. The same
forward cleanup repeats attributable verification removal after the verification write guard is
already active, covering rows that could have committed during an older migration's cleanup window.

Before applying the historical deletion-lifecycle migration, the project migration runner performs
an idempotent compatibility repair for legacy failed/processing requests whose completion timestamp
would violate the newer lifecycle constraint. Checked migration files remain immutable.

Deletion markers make interviews, transcripts, evaluations, Operations, reports, and account data
unavailable immediately. Application code must treat a `null` owner-scoped repository result as
non-disclosive. Operation creation locks the user and interview rows around lookup, deletion checks,
and insert, so concurrent deletion either prevents creation or atomically cancels the newly created
Operation.

## Physical purge

Eligible requests are selected with ordered `FOR UPDATE SKIP LOCKED`, but each request is claimed
only immediately before its purge attempt. The configured batch size bounds attempts per cycle
rather than simultaneously leased rows. Overdue monitoring uses the hard seven-day deadline rather
than the earlier eligibility time. Claim ordering places overdue work before pre-deadline work, then
uses the oldest effective attempt time to preserve fairness between new and previously failed
requests. A successful purge deletes the request, authentication rows, and business content in one
transaction and writes success audit rows in that same transaction. Audit rows contain only:

- HMAC-SHA-256 subject identifier hash;
- deletion timestamp;
- category;
- result.

The HMAC secret is `PURGE_AUDIT_HASH_SECRET` and must be distinct from authentication secrets. Failed
transactions create no success audit. The request remains retryable with only bounded category/code
metadata, and failure time comes from PostgreSQL. Retry eligibility is the earlier of the normal
backoff or one minute before the hard purge deadline; overdue work is always eligible. Purge leases
normally must be at least 30 seconds, but PostgreSQL caps each claimed lease at the earlier of the
configured duration and 30 seconds before the hard deadline. Claims already inside that safety
window, including overdue claims, receive a three-second positive fencing lease from PostgreSQL
time;
this deadline cap is the only path that may override the normal minimum. A lease is expired and
reclaimable when `lease_expires_at <= statement_timestamp()`, while the fenced worker may proceed
only while `lease_expires_at > statement_timestamp()`. Each maintenance cycle has a configured
request bound and attempts a claimed request at most once, including when purge loses its lease.
`getDeletionOverdueProjection()` exposes count, oldest deadline, and maximum overdue seconds for
monitoring.

Account purge removes Better Auth 1.6.26's exact sign-in, email-verification, and forgotten-password
OTP identifiers plus change-email identifiers prefixed by the account's current/old email. It does
not use suffix or wildcard matching. Better Auth's database-backed OAuth state is also covered:
random verification identifiers are owned only when safely parsed JSON contains a matching
`link.userId` or `link.email`. Invalid JSON, unrelated users' link state, non-link OAuth state, and
pre-account verification remain untouched. The write guard and purge serialize on the owning user,
and the transaction checks that no owned row remains before writing success audit rows. A
cookie-only OAuth state strategy is not required.

## Operational commands

Apply migrations:

```sh
pnpm --filter @interview-agent/db db:migrate
```

Run one maintenance cycle manually:

```sh
pnpm --filter @interview-agent/db db:maintenance
```

The command prints only aggregate counts and overdue timing. Batch, lease, and retry settings are
configured through the variables documented in `.env.example`. Production composition should call
`startPeriodicMaintenance()` at a low frequency (at least one minute) and stop its returned handle
during graceful shutdown.
