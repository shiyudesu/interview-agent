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

After the final question is frozen, the interview enters `report_pending`. A successful report Operation moves it to `completed`. A failed report Operation leaves it retryable in `report_pending`; it does not expose a partially generated report.

Early ending enters a partial-report pending path and becomes `early_ended` only after the incomplete report is stored. Explicit abandonment and expiry move directly to `abandoned` without a report.

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

Operations are executed inline for the MVP, but handlers accept persisted Operation IDs and do not depend on an HTTP request. A future PostgreSQL-backed worker can call the same OperationRunner.

### 5. Separate command responses from SSE event delivery

Mutating endpoints return an Operation ID. The browser subscribes to the Operation event endpoint using SSE for presentation deltas and completion status. Every event contains `operationId` and a monotonic in-memory sequence number.

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

`pi-ai` controlled calls return decision-bearing TypeBox payloads for:

- response classification;
- Rubric-item evidence and awarded points;
- eligibility of a predefined follow-up goal;
- report analysis fields and evidence references.

The Interview Engine validates every payload and performs all score calculations and state transitions. Schema failures receive one repair attempt with concrete validation errors. Transient provider failures receive at most two exponential-backoff retries. Exhaustion fails the Operation without changing interview state.

Every decision-bearing call records provider, model ID, prompt version, schema version, question version, purpose, latency, and token usage. User content is delimited as untrusted data, and no chain-of-thought is requested or stored.

### 9. Store reports as immutable structured snapshots

Per-question scores are computed from Rubric-item points. Main answers, supplements, and follow-up answers form one answer material set. Skip, unknown, unresolved irrelevant, and wholly incorrect outcomes receive zero while preserving distinct reason labels.

The domain layer computes integer question, domain, and overall scores. Model output supplies explanations and evidence references only. A versioned report JSON snapshot contains all display data required by the browser.

The report generator reads structured evaluations rather than the unrestricted transcript. Reports become immutable once stored. The system does not regenerate, rescore, append chat, export, or share them in the MVP.

### 10. Use Better Auth behind project-owned account workflows

Better Auth provides GitHub OAuth, email OTP, PostgreSQL sessions, and explicit linking. Configuration disables implicit linking and permits an authenticated user to link a GitHub identity with a different email without changing the primary email.

The server factory binds Better Auth to the checked Drizzle `user`, `session`, `account`, and
`verification` schema, disables cookie-cached sessions, and enables secure cookies in production.
Email OTP values are stored through an HMAC keyed by the authentication secret, with six digits,
five-minute expiry, three attempts, and rotation on resend. Better Auth change-email and direct
delete-user endpoints remain disabled because those workflows are project-owned.

The application owns interview-history access and deletion orchestration. Account deletion immediately revokes sessions and marks all related content inaccessible and non-restorable. A sweeper physically deletes authentication and business rows within seven days. Better Auth's immediate delete endpoint is not exposed directly.

Email delivery is behind an `EmailSender` port. The local adapter uses Nodemailer and Mailpit; a production adapter is deferred.
The adapter sends text-only OTP messages through validated SMTP host, port, and sender settings.
Delivery logs contain only fixed event and purpose fields; recipient addresses, OTP values, and raw
SMTP errors are never forwarded to Better Auth logging. Delivery failures are rethrown internally as
a fixed credential-free authentication error while the public send flow retains anti-enumeration
semantics. OTP expiry, attempt count, keyed storage, and resend rotation are configured centrally.

### 11. Validate configuration and secure the same-origin API

Node loads environment files natively and the server validates configuration through TypeBox before listening. Missing database, authentication, or selected model configuration fails startup. Real provider credentials are optional only for workflows and tests using the Faux Provider.

Production uses same-origin secure cookies, Origin/CSRF validation, security headers, and endpoint-specific rate limits. The application does not expose permissive CORS. OpenAPI and Swagger UI are enabled only for local and test environments.

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

## Risks / Trade-offs

- **Model scores can vary despite a fixed Rubric** → Build a versioned evaluation fixture set, assert structural and scoring invariants, record model/prompt versions, and calibrate before treating scores as reliable.
- **A full 90-question bank is a large content dependency** → Implement and validate the schema first, allow representative fixtures during development, and make the release gate enforce the final per-domain minimum.
- **Inline Operations can outlive an HTTP connection** → Persist Operation state before provider calls, continue processing after disconnect, and expose explicit retry and canonical status endpoints.
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
