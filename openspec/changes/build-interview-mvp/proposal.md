## Why

The repository currently contains an agreed product scope and technical architecture but no executable application or capability specifications. This change establishes the complete MVP for a recoverable, text-only Go backend mock interview with deterministic orchestration, evidence-based scoring, and immutable reports.

## What Changes

- Scaffold the TypeScript modular monolith, local development environment, database migrations, quality checks, and CI required to develop the application.
- Add GitHub and email OTP authentication, explicit account linking, interview history, and delayed physical deletion.
- Add an audited, versioned Go backend question bank with deterministic blueprint creation and per-session question snapshots.
- Add the recoverable interview workflow, including answers, supplements, clarification, bounded follow-ups, skipping, early ending, abandonment, expiry, and idempotent command processing.
- Add schema-constrained answer evaluation, deterministic score aggregation, complete and incomplete reports, and per-question feedback.
- Add browser flows for authentication, interview configuration, interview execution, history, reports, account settings, and deletion.
- Add observability and automated tests without depending on live model providers.

## Capabilities

### New Capabilities

- `account-access`: Authentication, explicit identity linking, account sessions, interview history access, and deletion lifecycle.
- `question-bank`: Versioned reviewed questions, rubric validation, deterministic selection, recent-question avoidance, and session snapshots.
- `interview-session`: Interview creation, state transitions, answer commands, clarification, follow-ups, recovery, concurrency control, and terminal states.
- `assessment-report`: Schema-constrained evaluation, deterministic scoring, complete and incomplete report generation, evidence, feedback, and immutable history.

### Modified Capabilities

None.

## Impact

- Introduces the pnpm/Turborepo workspace, React web application, Fastify server, pure domain package, shared TypeBox contracts, Drizzle data package, and versioned question-bank source.
- Introduces PostgreSQL and Mailpit for local development plus a production application container.
- Adds Better Auth, Pi Agent Core, pi-ai, database, telemetry, testing, and frontend dependencies defined in `docs/tech-stack.md`.
- Adds REST and SSE API surfaces under `/api/v1`, PostgreSQL migrations, structured model contracts, and CI validation.
