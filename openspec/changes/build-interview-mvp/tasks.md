## 1. Project Foundation

- [x] 1.1 Create the pnpm workspace, Turborepo configuration, root scripts, exact dependency versions, Node/pnpm version constraints, and lockfile.
- [x] 1.2 Scaffold `apps/web`, `apps/server`, `packages/domain`, `packages/contracts`, and `packages/db` with ESM TypeScript project references and enforced one-way package dependencies.
- [x] 1.3 Configure Biome, Vitest, coverage, shared TypeScript settings, environment-file loading, and TypeBox startup configuration validation.
- [x] 1.4 Add Docker Compose for PostgreSQL 18.4 and Mailpit 1.30.7, local environment examples, database readiness checks, and the production application Dockerfile.
- [x] 1.5 Add GitHub Actions for frozen dependency installation, question-bank validation, formatting/linting, type checking, tests, and build without live external credentials.
- [x] 1.6 Verify TypeScript 7 compatibility across the selected toolchain and document an explicit fallback decision if TypeScript 6.0.3 is required.

## 2. Domain Model and Contracts

- [x] 2.1 Define domain identifiers, interview statuses and phases, question outcomes, commands, events, report kinds, and repository/model ports without infrastructure dependencies.
- [x] 2.2 Implement and unit-test the interview state machine, including clarification, bounded follow-ups, explicit supplements, continuation, completion, early ending, abandonment, expiry, and terminal-state rejection.
- [x] 2.3 Implement and unit-test deterministic Rubric scoring, question/domain/overall aggregation, unassessed domains, and distinct zero-point reasons.
- [x] 2.4 Define TypeBox API request, response, error, Operation event, configuration, question-bank, evaluation, and report schemas in `packages/contracts`.
- [x] 2.5 Implement explicit DTO-to-domain and domain-to-DTO mappings and test that transport schemas do not leak into `packages/domain`.

## 3. Database and Persistence

- [x] 3.1 Configure Drizzle with `pg`, create Better Auth tables, and generate the initial checked-in PostgreSQL migration.
- [x] 3.2 Add interview sessions, question-bank versions, session question snapshots, messages, Operations, evaluations, reports, deletion requests, and purge audit tables.
- [x] 3.3 Add database constraints for one active/report-pending interview per user, ordered unique question positions, immutable snapshot identity, and scoped Operation idempotency keys.
- [x] 3.4 Implement repositories and transaction helpers for aggregate loading, optimistic version advancement, message/evaluation persistence, immutable reports, and history queries.
- [x] 3.5 Implement Operation lease, stale-processing reclaim, retry, and duplicate-result behavior with Testcontainers integration tests.
- [x] 3.6 Implement lazy interview expiry, the periodic expiry sweeper, deletion marking, seven-day physical purge, and non-reversible purge audit persistence.
- [x] 3.7 Add migration and repository integration tests against a clean PostgreSQL Testcontainer.

## 4. Question Bank

- [x] 4.1 Define the versioned YAML format and validator for stable IDs, domains, wording, Rubric weights, follow-up goals, knowledge explanations, and prohibited coding tasks.
- [x] 4.2 Implement question-bank import and version synchronization into PostgreSQL without mutating historical interview snapshots.
- [x] 4.3 Implement deterministic seeded blueprint selection for 5, 10, and 15 questions with domain coverage and recent-three-interview avoidance.
- [x] 4.4 Complete interview-creation orchestration using the existing per-session snapshot persistence and extend the existing cross-version immutability test through that orchestration path.
- [x] 4.5 Add representative development fixtures for all six domains so end-to-end development can proceed before the release bank is complete.
- [x] 4.6 Author and review at least 15 Go language and standard-library questions.
- [x] 4.7 Author and review at least 15 concurrency, runtime, and performance questions.
- [x] 4.8 Author and review at least 15 HTTP, RPC, and API questions.
- [x] 4.9 Author and review at least 15 database and storage questions.
- [x] 4.10 Author and review at least 15 cache, messaging, and distributed-system fundamentals questions.
- [x] 4.11 Author and review at least 15 testing, observability, and engineering-practice questions.
- [x] 4.12 Add a release validation gate requiring 90 valid active questions, at least 15 per domain, unique IDs/versions, and valid 100-point Rubrics.

## 5. Authentication and Account Access

- [x] 5.1 Configure Better Auth with the Drizzle adapter, PostgreSQL sessions, GitHub OAuth, email OTP, disabled implicit linking, and explicit different-email GitHub linking.
- [x] 5.2 Implement the `EmailSender` port and Nodemailer/Mailpit local adapter with OTP expiry, attempt limiting, resend behavior, and redacted logging.
- [x] 5.3 Mount Better Auth in Fastify and add authenticated request context, same-origin cookie settings, Origin/CSRF protection, and authentication-specific rate limits.
- [x] 5.4 Implement account profile, linked-identity listing/linking, session handling, and ownership checks for interviews and reports.
- [x] 5.5 Implement reverse-chronological interview history projections for completed, early-ended, and abandoned interviews.
- [x] 5.6 Complete authenticated request-layer interview/account deletion orchestration using the existing immediate-inaccessibility, session-revocation, delayed-purge, audit, and lifecycle-test foundation.

## 6. Model and Interviewer Adapters

- [x] 6.1 Implement environment-selected `pi-ai` provider/model construction plus a Faux Provider path for automated tests.
- [x] 6.2 Create versioned prompt and Schema registries for question rephrasing, clarification, follow-up wording, answer evaluation, and report analysis.
- [x] 6.3 Implement the no-tool Pi Agent interviewer adapter with bounded context, SSE text events, output checks, and reviewed-source fallback when question rephrasing fails.
- [x] 6.4 Implement the schema-constrained answer evaluation adapter with delimited untrusted input, one directed structure repair, two transient retries, and full model-version metadata.
- [ ] 6.5 Implement the schema-constrained report analysis adapter using structured evaluations rather than the unrestricted transcript.
- [ ] 6.6 Build evaluation fixtures covering correct, partially correct, incorrect, unknown, skipped, irrelevant, ambiguous, and prompt-injection-style answers.
- [ ] 6.7 Add Faux Provider tests for output validation, retry exhaustion, fallback wording, evidence references, and state-preserving failure behavior.

## 7. Operation Execution and API

- [ ] 7.1 Implement the persisted OperationRunner and handlers for interview creation, answer submission, supplements, question clarification, unknown, skip, continue, early end, abandon, and retry.
- [ ] 7.2 Add `/api/v1` command endpoints requiring Idempotency Keys and expected interview versions, with stable conflict and retryable-error responses.
- [ ] 7.3 Add canonical JSON endpoints for the current account, active interview, interview detail, Operation status, history, and report detail.
- [ ] 7.4 Add the Operation SSE endpoint with operation IDs, monotonic event sequence numbers, text deltas, terminal status events, and disconnect-safe processing.
- [ ] 7.5 Wire the existing domain/persistence supplement window through Operation handlers and API responses so the next main question is not revealed until the user continues.
- [ ] 7.6 Implement report-pending and incomplete-report-pending retry flows without re-running completed question evaluations.
- [ ] 7.7 Generate local/test OpenAPI documentation from TypeBox route schemas and keep Swagger disabled outside those environments.
- [ ] 7.8 Add API integration tests for authentication, ownership, idempotency, concurrency conflicts, expiry, terminal-state rejection, and SSE disconnect recovery.

## 8. Assessment and Reports

- [ ] 8.1 Connect schema-constrained evaluation adapters and Operation handlers to the existing structured evaluation persistence, Rubric evidence, points, follow-up eligibility, and zero-reason validation.
- [ ] 8.2 Implement complete-report analysis/generation and store it through the existing immutable versioned report persistence, including a valid zero-score complete report.
- [ ] 8.3 Implement incomplete-report analysis/generation after early ending and store it through the existing immutable report persistence without an overall score.
- [ ] 8.4 Apply the existing evidence and report validators to generated feedback, including tailored unknown, skipped, irrelevant, and incorrect zero-point feedback without complete reference answers.
- [ ] 8.5 Complete private report application/API access and unsupported-action rejection using the existing immutable persistence and recorded model/prompt/Schema/question-version validation.
- [ ] 8.6 Complete the remaining model/Operation integration coverage for report failure/retry while retaining the existing domain and persistence tests for complete/incomplete reports, unassessed domains, all-zero completion, and historical immutability.

## 9. Web Application

- [ ] 9.1 Create the React/Vite application shell with React Router, TanStack Query, Tailwind CSS, Radix primitives, shared API client, and accessible loading/error patterns.
- [ ] 9.2 Implement GitHub and email OTP authentication screens, unlinked-account guidance, explicit GitHub linking, and account settings.
- [ ] 9.3 Implement interview creation with the fixed Go backend direction, 5/10/15 question selection, and active-interview resume-or-abandon conflict flow.
- [ ] 9.4 Implement the active interview screen with question progress, answer submission, clarification, unknown, skip, bounded follow-up display, supplements, explicit continue, and disabled invalid actions.
- [ ] 9.5 Implement Operation SSE consumption, reconnect through canonical GET state, retryable failure UI, cross-device resume, and report-pending UI.
- [ ] 9.6 Implement history list and transcript detail for completed, early-ended, and abandoned interviews.
- [ ] 9.7 Implement complete and incomplete report views, domain and per-question feedback, unassessed markers, and immutable read-only behavior.
- [ ] 9.8 Implement interview/account deletion confirmations and immediate removal of deleted resources from the user-visible application.
- [ ] 9.9 Add React Testing Library coverage for critical forms, interview actions, report rendering, and deletion states.

## 10. Observability, Security, and Release Validation

- [ ] 10.1 Add Pino structured logging with request, interview, Operation, and trace correlation plus redaction of credentials, OTPs, tokens, and complete answers.
- [ ] 10.2 Add OpenTelemetry instrumentation for HTTP, PostgreSQL, Operations, and model calls with optional OTLP export.
- [ ] 10.3 Add endpoint-specific rate limits, security headers, same-origin checks, payload size limits, and tests for unauthorized or cross-origin requests.
- [ ] 10.4 Add Playwright critical-path tests for authentication substitutes, normal completion, all-zero completion, early ending, resume, report retry, history, and deletion.
- [ ] 10.5 Run the full evaluation fixture suite and document known model-quality limitations and the configured development model used for manual acceptance.
- [ ] 10.6 Run a production-container smoke test against clean PostgreSQL and Mailpit dependencies.
- [ ] 10.7 Update README setup commands and add repository development instructions only after all verified scripts and workflows exist.
- [ ] 10.8 Verify every OpenSpec scenario has automated coverage or a documented manual acceptance step and validate the change in strict mode.
