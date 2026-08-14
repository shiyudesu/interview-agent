## Context

The repository is a greenfield project with an agreed business scope in `docs/product.md`, an agreed technical baseline in `docs/tech-stack.md`, domain terminology in `CONTEXT.md`, and architecture decisions in `docs/adr/`. There is no application code, database schema, question-bank source, API contract, or CI workflow yet.

The MVP is a Chinese-language Go backend mock interview. It must preserve a deterministic interview blueprint, recover across devices and process restarts, constrain model behavior, produce evidence-backed immutable reports, and delete user content reliably. The implementation must remain a modular monolith and must not introduce Redis, a vector database, a message queue, or a second deployable service.

## Goals / Non-Goals

**Goals:**

- Deliver the complete account, question-bank, interview, assessment, report, history, and deletion flows defined by the four capability specs.
- Keep interview state and score aggregation deterministic and testable without a live model.
- Persist every state transition required for idempotent retries, recovery, and auditability.
- Provide a local development environment, repeatable migrations, CI, observability, and automated tests.
- Preserve one-way workspace dependencies so domain behavior remains independent from HTTP, database, authentication, and model frameworks.

**Non-Goals:**

- Additional interview directions, difficulty selection, coding questions, voice, video, resume analysis, enterprise-specific interviews, or social features.
- Runtime model switching, model failover, multi-agent orchestration, vector retrieval, or a question-bank administration UI.
- Production cloud, region, mail provider, telemetry backend, or deployment pipeline selection.
- Public API compatibility beyond the MVP `/api/v1` surface.

## Decisions

### 1. Build a pnpm/Turborepo modular monolith

The workspace will contain:

```text
apps/web
apps/server
packages/domain
packages/contracts
packages/db
question-bank
```

`packages/domain` owns the Interview Engine, commands, state transitions, score aggregation, and repository/model ports. It has no dependency on Fastify, Drizzle, Better Auth, Pi, TypeBox, or browser APIs. `packages/contracts` owns TypeBox transport schemas and maps to domain values. `packages/db` owns Drizzle schemas, migrations, and repository implementations. `apps/server` owns adapters and dependency composition. `apps/web` consumes only API contracts.

This is preferred over a server-centric package because Operation handlers and state transitions must be testable without infrastructure and reusable by a future worker.

The browser application is a Vite SPA with React Router, TanStack Query, Tailwind CSS, and focused
Radix primitives. Its shared fetch client always uses same-origin credentials, disables browser HTTP
caching in favor of Query state, and exposes an API error DTO only after the complete contracts
error envelope validates. Local Vite requests proxy `/api` to the configured Better Auth origin and
rewrite the proxied Origin/Host consistently. Production builds copy the Vite output into the Server
image; Fastify serves immutable assets and returns the uncached SPA entry only for non-API browser
navigations.

Interview creation in the Web application exposes only the fixed Go backend direction and the
supported 5, 10, or 15 question counts. The account-scoped active-interview query runs only after the
account projection resolves, treats only the owner-scoped interview 404 as absence, and is cleared
across authentication changes. A canonical unfinished interview replaces the creation form with a
resume action and shows abandonment only when the response explicitly permits it. Create and
abandon commands retain one Idempotency Key across ambiguous retries and re-read canonical state
after both success and failure, allowing recovery when durable acceptance outlives the HTTP response.

The active interview screen renders only canonical progress, current wording, transcript messages,
and `availableActions`. Every action remains visible but disabled when the server does not permit it;
answer and supplement forms are phase-specific. Text and control commands retain one idempotency key
for ambiguous retry, refresh both detail and dashboard caches, clear drafts when the canonical
version or question position changes, and suppress transport errors only when the refreshed version
proves the old draft is stale. Pending Operations are shown as busy even when the aggregate business
phase remains `awaiting_response`. Retryable report-pending failures expose only report Operation
retry and never rerun question evaluation.

The Web Operation client consumes SSE through `fetch` so it can validate every event, send
`Last-Event-ID`, inspect replay-unavailable status, and cancel invalid streams explicitly. It clears
the reconnect indicator as soon as a valid stream opens, retries only network and server failures,
stops on permanent 4xx responses, and refreshes the account projection on session expiry. Stream
closure or 409 first performs a direct canonical detail read; the loop stops only when that read
confirms the same Operation is no longer pending or processing. Thus page reloads and other devices
can resume processing without treating presentation text as durable state.

History uses the server's opaque keyset cursor through an account-scoped infinite query. Pages are
appended without interpreting or rewriting the cursor, load-more never races a background refresh,
and every page entry preserves the server's reverse chronological order and state-specific fields.
Terminal interview routes render their canonical read-only transcript for completed, early-ended,
and abandoned sessions. Local commands and terminal SSE reconciliation invalidate the dedicated
history cache, while entering the page always refreshes its first page.

Report routes load only the owner-scoped public report DTO and require both Schema and semantic
contract validation before rendering. Complete reports show their deterministic overall score;
incomplete reports explicitly omit it. Both render all six domain results, including unassessed
markers, the four report summary groups, and ordered per-question feedback with reason-specific
outcomes. The page exposes no regeneration, rescoring, export, sharing, or continued-chat controls
and links only back to the immutable transcript and history.

Interview and account deletion require an accessible modal confirmation and submit only
`confirmed: true` to the existing project-owned endpoints. The dialog remains open and
non-dismissible while the request is pending. Success removes account-owned Query data immediately
and navigates away from the deleted resource; an authoritative 401 clears all private caches and
returns to sign-in. Best-effort storage events notify other same-origin tabs of account or interview
deletion, and those tabs hard-navigate or reload so mounted observers cannot continue displaying
deleted content.

The Web RTL suite is mandatory and no longer permits an empty test set. It exercises authentication
forms and unlinked guidance, interview creation and every command endpoint, phase-specific active
controls, Operation streaming and recovery, history pagination, complete/incomplete report
rendering, and pending/success deletion states. The task 9.9 baseline contains 45 passing tests
across 11 files and records coverage for all Web source modules.

Playwright runs the built browser application against deterministic network substitutes rather than
live OAuth, PostgreSQL, SMTP, or model credentials. Eight serial critical-path cases cover email OTP
authentication, normal completion through answer and SSE, all-zero normal completion, early ending,
cross-reload resume, report-only retry, state-aware history/transcript access, and confirmed
deletion. The substitutes return only public API contracts and still exercise the real router,
fetch client, TanStack Query cache, SSE parser/reconciliation, forms, dialogs, and report semantic
validation. Local WSL execution starts the mounted Windows Chrome with a unique profile and connects
through CDP; CI uses the hosted runner's Chrome channel. Both paths run from `pnpm test:e2e`, use one
worker for deterministic stateful flows, retain failure traces/media, and clean browser processes
and profiles.

### 2. Model the interview as a persisted aggregate

An interview has a top-level status:

```text
active
report_pending
completed
early_ended
abandoned
deleting
```

An active interview also has a phase:

```text
awaiting_response
processing
awaiting_continue
```

The normal question loop is:

```text
awaiting_response
  ├── request clarification ───────────────▶ awaiting_response
  ├── submit answer/supplement/skip ───────▶ processing
  │                                             │
  │                                             ├── follow-up required
  │                                             │      ▼
  │                                             │ awaiting_response
  │                                             │
  │                                             └── question assessed
  │                                                    ▼
  └──────────────────────────────────────────── awaiting_continue
                                                       │
                                                       └── continue
                                                              ▼
                                                     next awaiting_response
```

`awaiting_continue` creates the explicit supplement window required by the product rules. The user can add a supplement while the current question remains selected, or explicitly continue to freeze the question and reveal the next main question. A supplement is evaluated through the same Operation path and can trigger a remaining bounded follow-up.

Canonical transcript messages carry their question position. Response mapping requires exactly one
snapshot-matching main-question message for every revealed position and rejects any message for a
future position. While `awaiting_continue`, the response keeps the assessed question wording and
progress unchanged and exposes only supplement, continue, early-end, abandon, and an applicable
retry action. A failed supplement persists no new answer material or text, retains the provisional
evaluation, and retries against the same immutable input. A successful supplement appends material
and replaces the current question evaluation without advancing. Only a successful continue freezes
the current question and reveals exactly the next main question; continuing the final question
enters complete `report_pending` without a new question wording.

After the final question is frozen, the interview enters `report_pending`. A successful report Operation moves it to `completed`. A failed report Operation leaves it retryable in `report_pending`; it does not expose a partially generated report.

Early ending enters a partial-report pending path and becomes `early_ended` only after the incomplete report is stored. Explicit abandonment and expiry move directly to `abandoned` without a report.

Final continue and early end create a persisted `generate_report` Operation after the aggregate
enters complete or incomplete `report_pending`. Report analysis consumes only immutable question
snapshots plus already stored structured outcomes and evaluations; it never calls the answer
evaluator or recomputes completed question scoring. Success stores the immutable report, completes
the Operation, and transitions to `completed` or `early_ended` in one transaction. All-zero complete
reports remain valid.

A model or transient report failure completes only the report Operation as retryable and leaves the
aggregate, evaluations, outcomes, and report request unchanged. Explicit retry and stale-lease
recovery reclaim only that `generate_report` Operation. Retry acceptance refreshes effective
activity from the database claim time without advancing the interview version, extending expiry
while preserving every assessment fact; report completion cannot precede that refreshed activity.
The retry command and target Operation terminate atomically, and canonical JSON/SSE continue to
surface only the report retry action until the report is stored.

### 3. Use explicit commands rather than infer control intent from text

The API will expose commands for:

- creating an interview;
- submitting an answer;
- supplementing an answer;
- requesting question clarification;
- marking the question as unknown;
- skipping the question;
- continuing to the next question;
- ending with an incomplete report;
- abandoning the interview;
- retrying a failed Operation.

Dedicated unknown and skip commands ensure honest non-answers cannot be mistaken for malformed model input. Free-text answer classification may still identify irrelevant content, but it does not replace explicit control commands.

### 4. Persist idempotent Operations around every model-assisted command

Each mutating request includes an Idempotency Key and expected interview version. In one database transaction the server:

1. loads or creates the Operation;
2. verifies ownership, interview status, phase, and expected version;
3. records the immutable command input;
4. marks the Operation as processing.

For a model-assisted user command, the same acceptance transaction advances the optimistic version,
refreshes effective activity, and records only technical processing metadata on the aggregate. It
does not expose or persist new answer material, interviewer text, evaluation facts, outcomes, or
question progress from that accepted command. Existing facts from earlier successful commands remain
unchanged, including the provisional assessment retained while a supplement is processing.

The OperationRunner performs model work outside the transaction. A second transaction stores
validated output, appends messages/evaluations, advances the business phase, clears processing
metadata, and completes the Operation. If model work fails, a transaction marks the Operation failed
and restores the previous business phase while retaining the accepted version and activity time.
Duplicate keys return the existing Operation and result. Competing commands fail with a version
conflict instead of both advancing the interview.

Operation acceptance is inline, but model and report execution are server-owned and must not keep the
originating HTTP response open. After the acceptance transaction commits, the command endpoint
returns the canonical pending or processing Operation with `202`. The server then executes the
claimed Operation independently of the request connection. Immediate non-model commands may still
complete synchronously. A future PostgreSQL-backed worker can call the same accepted-Operation
executor without changing command or persistence semantics.

The persisted `OperationRunner` owns creation, answer, supplement, question clarification, unknown,
skip, continue, early-end, abandon, and explicit retry handlers. Creation serializes on the account,
retries PostgreSQL serialization failures, commits the frozen interview/snapshots with a pending
creation Operation, blocks progress until finalization, and records an immutable version-1 result.
Model-assisted commands commit only the claimed Operation lease and accepted technical processing
state before calling adapters outside a transaction. Success or failure then commits the target
Operation, aggregate events/evaluation, and any retry-command Operation in one unit of work.

Explicit retry is itself an idempotent persisted `retry_operation` referencing immutable target
input. Retry and target claims share one database-generated lease deadline; stale target or retry
commands can be reclaimed, while retry-command rows are terminal and never recursively retryable.
Original answer/clarification event times always equal the target Operation's immutable creation
time; later retry acceptance only refreshes pending technical activity. Report-pending generation
uses the same persisted target/retry Operation rules while reusing stored evaluations rather than
re-running answer analysis.

### 5. Separate command responses from SSE event delivery

Mutating endpoints return the persisted Operation projection as soon as durable acceptance
completes. Model-assisted answer, supplement, clarification, report generation, and retry commands
therefore return `202` with the Operation ID before waiting for model output. The browser can
subscribe immediately to the Operation event endpoint using SSE for presentation deltas and
completion status. Every event contains `operationId` and a monotonic in-memory sequence number.

The server owns every scheduled execution promise and records sanitized failures. Closing the
command response or SSE connection never aborts provider work or database finalization. A duplicate
Idempotency Key returns the same canonical Operation whether it is still processing or already
terminal. The API integration suite must prove the real sequence
`POST command -> 202 Operation -> SSE -> canonical terminal state` against PostgreSQL and the Faux
Provider rather than publishing broker events directly in place of command execution.

Text deltas are not durable facts. Only the final validated text is stored atomically when an Operation succeeds. If the stream disconnects, processing continues and the browser reloads the canonical interview or Operation resource through JSON GET endpoints. The server does not permanently replay text deltas.

### 6. Keep PostgreSQL authoritative

The initial relational model contains:

- Better Auth user, account, session, and verification tables;
- interview sessions and their versioned state;
- imported question-bank records and versions;
- per-session question snapshots;
- interview messages;
- persisted Operations;
- structured per-question evaluations;
- immutable report snapshots;
- deletion requests and non-reversible purge audit events.

The database enforces one active interview per user with a partial unique constraint covering active and report-pending states. Question positions are unique within a session. Operation idempotency keys are unique per authenticated user and command scope.

JSONB stores versioned Rubrics, follow-up goals, model result payloads, and report snapshots where the schema is validated at the application boundary. Frequently queried lifecycle fields remain relational columns.

Repository persistence is transition-oriented rather than a generic aggregate overwrite. Saves receive the previous and current Interview plus emitted events, advance or verify the optimistic version with `WHERE id = ? AND version = ?`, and persist mutable lifecycle columns, messages, evaluation replacement, and a final report in one transaction. Immutable blueprint and Operation command-input fields are never included in update sets.

Application services use a PostgreSQL repository unit of work that binds Interview, Operation, and report repositories to one Drizzle transaction executor. Transaction-bound methods execute directly on that executor rather than opening nested or independent transactions, so Operation completion and aggregate/report persistence commit or roll back together.

Aggregate reads reconstruct the pure domain Interview from ordered relational children and validate every persisted JSON value and cross-row invariant through domain-safe decoders. Invalid snapshots, evaluations, pending Operation metadata, or reports raise an explicit corruption error rather than being defaulted. Owner-scoped report, history, and transcript reads exclude deletion-marked interviews and accounts; complete history entries expose an overall score, while incomplete and abandoned entries do not.

The accepted processing state stores the pending Operation ID alongside its kind, question position, acceptance time, and previous phase, and requires the referenced Operation to be processing. Successful completion may atomically mark it succeeded while clearing the pending reference; cancellation may atomically mark it failed while restoring the accepted aggregate version and activity. A current evaluation is unique per question snapshot and is deleted before supplement-driven reassessment; a report is unique per interview and is inserted only with the matching final aggregate transition.

Every persisted interview message receives a positive per-interview sequence assigned after optimistic ownership of the aggregate row is established. Reads order by this sequence rather than message identity or timestamp, and the database enforces uniqueness per interview. The task 3.4 migration deterministically backfills existing messages by creation time and stable message ID before making the sequence required.

The same migration locks interview and Operation rows while hydrating legacy pending Operation IDs. It requires exactly one processing Operation matching owner, interview, command type, accepted timestamp, expected version, and question position, and aborts before enabling the pending-state constraint when the match is missing or ambiguous.

Production logging uses Pino with server-generated UUID request IDs and allowlisted request lifecycle
events. A valid W3C `traceparent` contributes only its trace ID; route parameters add interview and
Operation IDs, while command results log Operation type and terminal/processing status. Fastify's
raw automatic request/error logging is disabled. Request serializers remove query strings, error
serializers discard messages and stacks, and redaction covers credentials, cookies, OTPs, API keys,
tokens, answer fields, text/content fields, and request/response bodies.

OpenTelemetry initializes before Fastify or PostgreSQL modules load, but only when
`OTEL_EXPORTER_OTLP_ENDPOINT` is configured. The endpoint is an HTTP(S) OTLP base URL without URL
credentials, query values, or fragments; the server exports traces to its `/v1/traces` path and
explicitly disables ambient log and metric exporters. Automatic instrumentation is limited to HTTP
and `pg`: query-bearing HTTP requests are skipped so callback codes and other query values cannot
enter spans, and PostgreSQL parameter capture, SQL commenter injection, and session propagation are
disabled. Operation acceptance/execution and model calls use explicit allowlisted spans containing
only resource IDs, types, statuses, versions, retry/repair counts, provider/model identity, and token
counts. They never attach command payloads, answers, prompts, model text, credentials, exception
messages, or stacks. Without the endpoint, the OpenTelemetry API remains a safe no-op and no exporter
or background telemetry pipeline starts.

### 7. Maintain and import the question bank as reviewed YAML

The repository stores one or more YAML files per Go backend knowledge domain. A TypeBox schema validates:

- stable question ID and monotonically increasing content version;
- domain and medium difficulty;
- audited Simplified Chinese source wording, with English limited to technical terms and identifiers;
- Simplified Chinese Rubric items whose integer weights total 100;
- Simplified Chinese follow-up goals and their type;
- Simplified Chinese knowledge explanation;
- prohibition of candidate-facing code-reading, code-writing, pseudocode, executable-deliverable, and automated-judging tasks.

CI runs the release validator, which evaluates the highest content version for each stable ID and
requires at least 90 current active reviewed questions, at least 15 in each domain, unique ID/version
pairs, no superseded active version, and valid 100-point Rubrics.
Until the release bank is complete, the repository keeps three reviewed development questions per
domain so all supported blueprint sizes can be exercised without weakening the release gate.

Blueprint creation reads only current active, source-active, reviewed medium questions and uses a
versioned selection seed derived from the interview ID. For five questions, it omits the feasible
domain that minimizes unavoidable recent-question reuse, using the seed as the deterministic
tie-breaker. For ten questions, it first reserves two Go, two concurrency/runtime/performance, and
one from every other domain; for fifteen, it first reserves two from every domain. Remaining flexible
slots are filled from a global stable seeded ordering of unseen candidates before any recent
candidate is considered. A shortage is returned before a partial blueprint when mandatory domain
coverage or total eligible capacity cannot be satisfied.

Interview creation runs the active-interview check, eligible/recent reads, deterministic selection,
domain creation, and aggregate insert through one serializable repository unit of work. The complete
selected question, source/display wording, Rubric, follow-up goals, knowledge explanation, and
version are copied into session snapshots before the first question can be returned. Historical
interviews never read live question-bank rows.

### 8. Treat model text and model facts differently

Pi Agent Core is used only for streamed interviewer text:

- surface-only main-question rephrasing;
- question clarification;
- bounded follow-up wording;
- transition language.

The Agent has no tools. It receives only the current question snapshot, the allowed wording objective, and the minimum required context. If main-question rephrasing fails, the system displays the reviewed source wording rather than blocking the interview.

The interviewer adapter creates a fresh single-turn Pi Agent with `tools: []` for each rephrase,
clarification, or predefined-goal follow-up. Candidate/model-authored text remains Base64URL-framed;
text calls receive no Rubric content, other follow-up goals, knowledge explanation, or unrelated
transcript. Follow-up answer context is capped at eight items and 12,000 characters. Final text must
pass the registered Schema, Simplified-Chinese, private-label, technical-term, semantic-anchor, and
single-follow-up checks. Deltas are buffered until the final output passes validation so rejected
content cannot leak through presentation events. Invalid/failed rephrasing emits the reviewed source
wording with attempted-model metadata; clarification and follow-up failures remain explicit.

At startup the server constructs exactly one `pi-ai` provider/model runtime. Real providers keep
their native credential transformation while reading one immutable configured API-key credential
with no ambient environment fallback. Dynamic catalogs refresh through the configured provider
gateway with a ten-second startup timeout before the selected model is locked. The public runtime
exposes no login, credential override, provider mutation, request-time auth override, or alternate
model dispatch surface. Automated tests use a narrowed deterministic Faux controller that can queue
responses but cannot mutate provider delegation.

`pi-ai` controlled calls return decision-bearing TypeBox payloads for:

- response classification;
- Rubric-item evidence and awarded points;
- eligibility of a predefined follow-up goal;
- report analysis fields and evidence references.

All five model purposes use immutable prompt and output-Schema registries with explicit current
versions. Candidate text and previously model-authored text are Base64URL-framed JSON in separate
untrusted blocks, so delimiter strings cannot escape their frame. Trusted blocks contain only
server-owned question facts, Rubric/goal identifiers, deterministic outcomes, scores, and versions.
Evaluation and report model-output Schemas exclude provider/model/prompt/schema, latency, and token
metadata; adapters attach those facts after the call completes.

The Interview Engine validates every payload and performs all score calculations and state transitions. Schema failures receive one repair attempt with concrete validation errors. Transient provider failures receive at most two exponential-backoff retries. Exhaustion fails the Operation without changing interview state.

The answer-evaluation adapter submits exactly one constrained output-tool value using the registered
metadata-free Schema. It validates every Rubric ID exactly once, per-item weights, supplied evidence
IDs, bounded missing/incorrect text, classification-compatible unused follow-up goals and kinds, and
the first-irrelevant clarification rule before returning domain values. One repair call receives all
independently detectable sanitized issues plus Base64URL-framed invalid output. Initial and repair
calls each reserve system, tool-Schema, output, and retry space within the fixed model context.
Provider failures retain attempted-call metadata; only transient failures receive at most two
100/200 ms retries.

Every decision-bearing call records provider, model ID, prompt version, schema version, question version, purpose, latency, and token usage. User content is delimited as untrusted data, and no chain-of-thought is requested or stored.

### 9. Store reports as immutable structured snapshots

Per-question scores are computed from Rubric-item points. Main answers, supplements, and follow-up answers form one answer material set. Skip, unknown, unresolved irrelevant, and wholly incorrect outcomes receive zero while preserving distinct reason labels.

The domain layer computes integer question, domain, and overall scores. Model output supplies explanations and evidence references only. A versioned report JSON snapshot contains all display data required by the browser.

The report generator reads structured evaluations rather than the unrestricted transcript. Reports become immutable once stored. The system does not regenerate, rescore, append chat, export, or share them in the MVP.

The report-analysis adapter reconstructs deterministic scores and domain coverage from validated
question outcomes, then sends only server-owned IDs/scores/outcomes/versions plus Base64URL-framed
model-authored evaluation text and bounded answer evidence. It canonicalizes missing-point text by
Rubric ID/order, requires exact question/evidence coverage, rejects internal-source leakage,
model-authored report-kind/score claims, wrong zero-reason or scored-outcome prose, and non-Chinese
analysis. Initial and repair calls reserve conservative UTF-8 input, tool framing, and dynamically
available output capacity; one repair and two transient retries share the same bounds and attach
attempted-call metadata on failure.

Final report construction adds deterministic minimum feedback for every zero-point reason. Unknown
and skipped questions discard model-authored answer analysis entirely, state the public question
goal and missing answer evidence, and provide one safe learning action. Irrelevant and incorrect
questions receive deterministic reason-specific framing around validated model detail, while
incorrect feedback retains the persisted missing or incorrect concepts and accepted answer
evidence. Reports whose selected questions all score zero use deterministic global summaries so
model prose cannot invent strengths or successful answers.

Private assessment content is checked at answer-evaluation acceptance, report-analysis acceptance,
and final report persistence. The shared validation covers Rubric and follow-up identifiers, exact
private text, ordered fragments distributed across fields, and cross-question leakage. Final
question-level evidence may cite any accepted answer material used by the report analysis; evidence
attached to an awarded or missing Rubric point remains constrained to that persisted evaluation
fact.

### 10. Use Better Auth behind project-owned account workflows

Better Auth provides GitHub OAuth, email OTP, PostgreSQL sessions, and explicit linking. Configuration disables implicit linking and permits an authenticated user to link a GitHub identity with a different email without changing the primary email.

The Web authentication flow calls the existing Better Auth JSON endpoints directly. It requests and
verifies email OTPs, starts GitHub sign-in or authenticated link redirects, and then reloads the
project-owned `/api/v1/account` projection for linked identities and live token-free sessions.
Unlinked OAuth failures explicitly direct the user to authenticate through the existing email method
before linking; the UI never offers implicit merge behavior. Non-production Better Auth origin
validation admits only the fixed local Vite origins in addition to the configured application
origin, while production trusts only the configured origin.

The server factory binds Better Auth to the checked Drizzle `user`, `session`, `account`, and
`verification` schema, disables cookie-cached sessions, and enables secure cookies in production.
Email OTP values are stored through an HMAC keyed by the authentication secret, with six digits,
five-minute expiry, three attempts, and rotation on resend. Better Auth change-email and direct
delete-user endpoints remain disabled because those workflows are project-owned.

The application owns interview-history access and deletion orchestration. Account deletion immediately revokes sessions and marks all related content inaccessible and non-restorable. A sweeper physically deletes authentication and business rows within seven days. Better Auth's immediate delete endpoint is not exposed directly.

Account access projects the primary email identity, configured GitHub links, and only unexpired
database sessions; internal Better Auth credential rows and all token fields remain private. Blank
OTP-created display names are represented as absent rather than corruption. Interview and report
access always calls owner-scoped repositories and maps both missing and non-owned resources to the
same not-found result.

Authenticated deletion endpoints require an explicit `confirmed: true` body and delegate to the
existing lifecycle repository. Interview deletion is owner-scoped and uses the same not-found
response for missing and non-owned IDs. Account deletion revokes every database session in the same
transaction that makes all account content inaccessible. Both endpoints return only the deletion
state and purge deadline; unexpected repository failures are logged without exception details and
mapped to a fixed schema-defined error.

Email delivery is behind an `EmailSender` port. The local adapter uses Nodemailer and Mailpit; a production adapter is deferred.
The adapter sends text-only OTP messages through validated SMTP host, port, and sender settings.
Delivery logs contain only fixed event and purpose fields; recipient addresses, OTP values, and raw
SMTP errors are never forwarded to Better Auth logging. Delivery failures are rethrown internally as
a fixed credential-free authentication error while the public send flow retains anti-enumeration
semantics. OTP expiry, attempt count, keyed storage, and resend rotation are configured centrally.

### 11. Validate configuration and secure the same-origin API

Node loads environment files natively and the server validates configuration through TypeBox before listening. Missing database, authentication, or selected model configuration fails startup. Real provider credentials are optional only for workflows and tests using the Faux Provider.

The Faux Provider is a development, CI, and automated-test facility. Startup MUST reject
`NODE_ENV=production` with `MODEL_PROVIDER=faux` so a deterministic test provider cannot silently
serve production traffic.

Production uses same-origin secure cookies, Origin/CSRF validation, security headers, and endpoint-specific rate limits. The application does not expose permissive CORS. OpenAPI and Swagger UI are enabled only for local and test environments.

Fastify applies Helmet globally, including a production Content Security Policy and one-year HSTS;
local and test environments keep CSP disabled so the generated Swagger UI remains usable. Unsafe
`/api/v1` methods reject an untrusted `Origin` or cross-site Fetch Metadata value before session
loading, while requests without browser origin metadata remain available to same-host operational
clients. Better Auth retains its independent CSRF and trusted-origin enforcement for `/api/auth/*`.
The socket-derived Fastify IP keys in-memory, per-endpoint one-minute limits: 120 reads, 30 commands,
20 SSE connections, and 5 deletion requests. Exceeded limits return a Schema-valid `429` envelope
and `Retry-After`; store errors fail closed.

The server-wide body ceiling is 96 KiB. Authentication routes allow 16 KiB, control commands 4 KiB,
answer and supplement commands 96 KiB so the existing 20,000-character contract remains valid for
four-byte Unicode, and deletion confirmations 1 KiB. Oversized payloads return a stable `413`
envelope before parsing; cross-origin mutations return a stable `403` envelope. These errors are
part of the shared contracts and remain distinguishable from validation, authentication, and
internal failures.

Fastify mounts Better Auth under `/api/auth/*`, preserves JSON and URL-encoded request bodies, and
forwards every response and session-refresh `Set-Cookie` header. Protected `/api/v1` routes receive
a normalized account/session context from PostgreSQL-backed Better Auth sessions. The bridge
overwrites a private client-IP header from Fastify's socket-derived `request.ip`; Better Auth uses
only that header for authentication rate limits, so client-supplied forwarding headers cannot
choose rate-limit keys. CSRF and trusted-origin checks remain explicitly enabled in every
environment, including tests. Runtime shutdown handles SIGINT/SIGTERM through `app.close()` so
in-flight authentication work and the database pool close through Fastify lifecycle hooks.

The server composes one long-lived Operation runner at startup and exposes authenticated command
routes under `/api/v1/interviews`. Creation, answers, supplements, clarification, unknown, skip,
continue, early end, abandon, and explicit retry all require an ASCII Idempotency Key and a bounded
PostgreSQL-compatible expected version; creation accepts version `0` only. Interview and Operation
identifiers and request timestamps are generated by the server. Replays return the canonical
persisted Operation rather than advancing state again. Terminal success returns `200`, pending or
processing work returns `202`, retryable/model failures return a sanitized `503` Operation failure,
and expected command conflicts return `409`. Version conflicts include the current canonical
version and possible status/phase combination, while inaccessible or deletion-marked resources are
hidden behind `404`. Request validation and content parsing failures use a stable `400` envelope,
and internal exception details, provider messages, idempotency keys, and repository identifiers are
never exposed.

Deletion routes use the same TypeBox-owned parameter and stable error-envelope contracts as the
other `/api/v1` routes, including explicit `400`, `401`, `404`, `202`, and `500` responses.
Successful account or interview deletion synchronously erases matching in-memory Operation-event
history and closes streams. This erasure path is total and non-throwing by construction; unexpected
auxiliary publication failures are logged with fixed redacted fields rather than silently ignored.

Canonical authenticated reads expose the current account, active interview, interview detail,
Operation status, reverse-chronological history, and immutable report detail under `/api/v1`.
Account responses include primary and linked identities plus only unexpired token-free session
metadata, including which session is current. Interview projections are assembled in one
repeatable-read transaction so aggregate and Operation state cannot tear across concurrent
completion. Lazy expiry is persisted and then transparently re-read: the active resource
disappears, while detail and Operation reads return their post-expiry canonical state on the first
request. Transcripts synthesize a stable main-question message for every revealed snapshot using
the interview creation time or the previous question's frozen time, and never expose unrevealed
questions or assessment metadata.

History uses a bounded opaque Base64URL keyset cursor over a PostgreSQL millisecond-normalized
`ended_at` value plus interview ID, matching JavaScript timestamp precision without gaps or
duplicates. Read endpoints apply owner-scoped repositories and the same not-found response to
missing, non-owned, deletion-marked, and account-deleting resources. Canonical interview reads
surface only the lifecycle-relevant pending or retryable failed Operation; newer rejected commands
cannot hide retry actions, and a durable pending creation Operation suppresses interview actions
until finalization. Successful report Operations use a report-only result projection rather than
inventing an interview version.

Operation events are exposed at `/api/v1/operations/{operationId}/events` as authenticated,
owner-scoped SSE. Each event carries the Operation ID, an increasing process-local sequence,
timestamp, and either validated final interviewer text or one sanitized terminal status. The model
adapter still withholds raw deltas until the full response passes semantic validation; a text-bearing
completion publishes its final text and terminal status as one synchronous broker batch after the
database transaction commits. Canonical polling waits through a short post-commit grace period so
it cannot overtake that batch. Broker publication is auxiliary and cannot turn a committed command
into an apparent failure.

The shared broker retains a bounded number of events and Operations for one minute, sends heartbeat
comments, and closes listeners and timers on disconnect or Fastify `preClose`. It tracks attempt
counts so retry targets discard stale terminal payloads while retaining increasing sequence numbers.
`Last-Event-ID` replays only when continuity is provable; truncated history, process restart, or a
canonical terminal rebuilt after history loss returns a stable replay-unavailable response for any
nonzero event ID. The client then reloads canonical JSON state instead of accepting fabricated
sequence continuity.

Every delivery and status poll revalidates the original unexpired database session and owner-scoped
Operation. Revoking one session closes only that stream, while interview or account deletion closes
and erases every matching listener and replay buffer immediately. Short-lived account, interview,
and Operation tombstones prevent in-flight publishers or polls from recreating erased text and are
removed by scheduled expiry. Client disconnect never cancels the server-owned Operation execution.

### 12. Establish tests and CI with the scaffold

The first implementation slice creates:

- Biome formatting and linting;
- TypeScript project references and type checking;
- strict TypeScript checking for discovered test sources;
- Vitest unit tests for domain transitions and scoring;
- Testcontainers integration tests for migrations, constraints, repositories, and idempotency;
- Pi Faux Provider tests for model contracts and retries;
- React Testing Library component tests;
- Playwright critical-flow tests once browser flows exist;
- GitHub Actions running install, question-bank validation, lint, typecheck, tests, and build.

CI uses no live model, OAuth, or email provider credentials.
Test tasks are not cached because database-time and container lifecycle assertions must execute on
every validation run. Packages with implemented suites fail when no tests are discovered; the empty
web suite remains explicitly allowed only until its planned UI testing task is implemented.

The versioned evaluation fixture suite pins the current prompt/Schema versions and covers correct,
partial, wholly incorrect, explicit unknown, explicit skipped, irrelevant-after-clarification,
ambiguous, and prompt-injection answers. Model-evaluated fixtures carry valid evidence and
follow-up-state semantics; unknown/skip fixtures explicitly bypass the model. Fixture validation
mirrors production Rubric, missing-point, follow-up-kind, identifier, Simplified-Chinese, and
untrusted-framing rules, and request builders create fresh Date values to prevent cross-test
mutation.

The suite is also an explicit release command, `pnpm model-quality:validate`, and CI executes it
before the general test step so a filtered package test cannot silently omit the model-quality
baseline. `docs/model-quality.md` records the pinned suite and contract versions, the configured
manual-acceptance target `opencode-go/deepseek-v4-flash`, the provider opt-in blocker that currently
prevents a reproducible live calibration result, and the limits of Faux, single-question fixtures,
language checks, and prompt-injection coverage. No live-model quality claim is made until that
manual gate can run and its versioned results are reviewed.

Faux Provider tests additionally prove invalid or failed interviewer output emits no pre-validation
deltas, rephrase fallback uses reviewed text, transient retries exhaust deterministically, evidence
is required and question-scoped, unknown/skipped feedback cannot cite answer evidence, adapter input
objects remain unchanged after failure, and domain cancellation restores answer, supplement, and
clarification phases without new business facts.

## Risks / Trade-offs

- **Model scores can vary despite a fixed Rubric** → Build a versioned evaluation fixture set, assert structural and scoring invariants, record model/prompt versions, and calibrate before treating scores as reliable.
- **A full 90-question bank is a large content dependency** → Implement and validate the schema first, allow representative fixtures during development, and make the release gate enforce the final per-domain minimum.
- **In-process Operations can outlive their originating HTTP connection** → Persist Operation state before provider calls, continue processing after disconnect, and expose explicit retry and canonical status endpoints.
- **Detached in-process execution can be lost on process termination** → Persist acceptance and leases before scheduling, expose explicit retry/stale reclaim, and keep the executor replaceable by a future PostgreSQL worker.
- **A process crash can leave an Operation in processing state** → Record leases/timestamps and allow stale processing Operations to be reclaimed by an explicit retry without duplicating state transitions.
- **Report generation can fail after all questions are answered** → Keep the interview in `report_pending`, preserve evaluations, and retry only report generation.
- **Seven-day delayed purge temporarily retains inaccessible content** → Revoke access immediately, encrypt infrastructure backups, restrict purge tables, and monitor overdue deletion requests.
- **Exact dependency versions become stale** → Treat package manifests and the lockfile as the implementation source of truth after scaffolding; update `docs/tech-stack.md` only when the supported baseline changes.
- **TypeScript 7 ecosystem incompatibility may surface during scaffolding** → Verify all selected tools in the foundation slice and fall back to TypeScript 6.0.3 only through an explicit design update.

## Migration Plan

This is a greenfield implementation with no existing application data.

1. Create the workspace, local dependencies, CI, and initial database migration.
2. Add question-bank validation and development fixtures.
3. Add account access and deletion foundations.
4. Implement the interview aggregate and persistence.
5. Add model adapters, Operation execution, streaming, and assessment.
6. Add reports, history, and browser flows.
7. Replace development question fixtures with the release bank and run the full validation and evaluation suite.

Rollback before production consists of reverting the change and dropping the local development database. Once deployed with user data, rollback must preserve database rows and use forward migrations.

## Open Questions

- The production model provider, model ID, mail provider, cloud platform, region, and telemetry backend remain deployment-time choices and are not required for local MVP implementation.
