import { request as httpRequest } from "node:http";

import { type OperationEventDto, OperationEventSchema } from "@interview-agent/contracts";
import {
  PgInterviewRepository,
  PgLifecycleRepository,
  PgOperationRepository,
  PgQuestionBankRepository,
  PgRepositoryUnitOfWork,
  type QuestionBankImportEntry,
  QuestionBankImportService,
  type StoredOperation,
  session,
  user,
} from "@interview-agent/db";
import {
  type AccountId,
  type AnswerEvaluationModel,
  type AnswerEvaluationRequest,
  type AnswerEvaluationResult,
  type InterviewerTextEvent,
  type InterviewerTextModel,
  type InterviewerTextRequest,
  KNOWLEDGE_DOMAINS,
  type ModelCallMetadata,
  parseAccountId,
  parseInterviewId,
  parseOperationId,
  type ReportAnalysisModel,
  type ReportAnalysisRequest,
  type ReportAnalysisResult,
} from "@interview-agent/domain";
import type { BetterAuthOptions } from "better-auth";
import { Check } from "typebox/value";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  databaseNow,
  type PostgresTestDatabase,
  PostgresTestHarness,
} from "../../../packages/db/test/support/postgres-test-harness.js";
import { questionDefinitionFixture } from "../../../packages/db/test/support/question-definition-fixture.js";
import { registerApplication } from "../src/app.js";
import {
  type Authentication,
  BETTER_AUTH_SESSION_COOKIE_NAME,
  createAuthentication,
} from "../src/auth.js";
import { createInterviewCommandRouteDependencies } from "../src/command-routes.js";
import { DeletionOrchestrationService } from "../src/deletion.js";
import type { EmailSender, VerificationOtpEmail } from "../src/email-sender.js";
import {
  createOperationEventRouteDependencies,
  OperationEventBroker,
  type OperationEventPublisher,
} from "../src/operation-events.js";
import {
  InterviewOperationHandlers,
  OperationRunner,
  ServerOwnedOperationSupervisor,
} from "../src/operation-runner.js";
import { createCanonicalReadRouteDependencies } from "../src/read-routes.js";
import { createServer } from "../src/server.js";

const OWNER = accountFixture("api-owner", "owner@example.test", "Owner");
const OTHER = accountFixture("api-other", "other@example.test", "Other");
const THIRD = accountFixture("api-third", "third@example.test", "Third");
const FOURTH = accountFixture("api-fourth", "fourth@example.test", "Fourth");
const ACCOUNTS = [OWNER, OTHER, THIRD, FOURTH] as const;
const MODEL_METADATA = {
  provider: "faux",
  modelId: "api-integration-faux",
  promptVersion: "test-v1",
  schemaVersion: "test-v1",
  questionVersion: 1,
  purpose: "answer_evaluation",
  latencyMs: 1,
  inputTokens: 1,
  outputTokens: 1,
} as const satisfies ModelCallMetadata;
const TEST_AUTH_CONFIG = {
  environment: "test",
  auth: {
    secret: "0123456789abcdef0123456789abcdef",
    baseUrl: "http://localhost:3000",
  },
} as const;
const OPERATION_ACCOUNT_LOCK_HOLDER_APPLICATION_NAME =
  "api-integration-operation-account-lock-holder";
const OPERATION_ACCOUNT_LOCK_WITNESS_QUERY = `
  with recursive
  holder as (
    select pid
      from pg_stat_activity
     where pid = $1
       and datname = current_database()
       and backend_type = 'client backend'
       and application_name = '${OPERATION_ACCOUNT_LOCK_HOLDER_APPLICATION_NAME}'
       and state = 'idle in transaction'
  ),
  waiting_requests as (
    select activity.pid, activity.query
      from pg_stat_activity activity
     where activity.datname = current_database()
       and activity.backend_type = 'client backend'
       and activity.pid <> pg_backend_pid()
       and activity.pid <> $1
       and activity.state = 'active'
       and activity.wait_event_type = 'Lock'
       and activity.query ~* 'select\\s+"deletion_requested_at"\\s+from\\s+"user"\\s+where\\s+"user"\\."id"\\s*=\\s*\\$1\\s+limit\\s+\\$2\\s+for\\s+update'
       and exists (
         select 1
           from pg_locks waiting_lock
          where waiting_lock.pid = activity.pid
            and not waiting_lock.granted
            and waiting_lock.locktype in ('transactionid', 'tuple')
       )
  ),
  blocker_chain(waiting_pid, blocker_pid, path) as (
    select waiting.pid,
           blocker.pid,
           array[waiting.pid, blocker.pid]
      from waiting_requests waiting
      cross join lateral unnest(pg_blocking_pids(waiting.pid)) blocker(pid)
    union all
    select chain.waiting_pid,
           blocker.pid,
           chain.path || blocker.pid
      from blocker_chain chain
      cross join lateral unnest(pg_blocking_pids(chain.blocker_pid)) blocker(pid)
     where not blocker.pid = any(chain.path)
  )
  select waiting.pid,
         waiting.query,
         array(
           select distinct waiting_lock.locktype
             from pg_locks waiting_lock
            where waiting_lock.pid = waiting.pid
              and not waiting_lock.granted
              and waiting_lock.locktype in ('transactionid', 'tuple')
            order by waiting_lock.locktype
         ) as waiting_lock_types,
         array(
           select distinct chain.blocker_pid
             from blocker_chain chain
            where chain.waiting_pid = waiting.pid
            order by chain.blocker_pid
         ) as blocker_pids
    from waiting_requests waiting
   where exists (
     select 1
       from blocker_chain chain
       join holder on holder.pid = chain.blocker_pid
      where chain.waiting_pid = waiting.pid
   )
   order by waiting.pid
`;

let harness: PostgresTestHarness;
let testDatabase: PostgresTestDatabase;
let unitOfWork: PgRepositoryUnitOfWork;
let interviewRepository: PgInterviewRepository;
let operationRepository: PgOperationRepository;
let applicationSequence = 0;
const applications: TestApplication[] = [];

describe.sequential("real API integration", () => {
  beforeAll(async () => {
    harness = await PostgresTestHarness.start();
    testDatabase = await harness.createDatabase({ name: "server_api_integration" });
    unitOfWork = new PgRepositoryUnitOfWork(testDatabase.client.database);
    interviewRepository = new PgInterviewRepository(testDatabase.client.database);
    operationRepository = new PgOperationRepository(testDatabase.client.database);
  }, 120_000);

  beforeEach(async () => {
    await testDatabase.pool.query(
      `truncate table "user", question_bank_versions restart identity cascade`,
    );
    await seedAccounts();
    await seedQuestionBank();
  });

  afterEach(async () => {
    for (const application of applications) {
      application.interviewer.releaseAll?.();
      application.evaluator.releaseAll?.();
    }
    for (const application of applications.splice(0).reverse()) {
      await closeApplication(application);
    }
  });

  afterAll(async () => {
    await harness?.stop();
  });

  it("signs in through the real Better Auth email OTP routes and protects API access with its cookie", async () => {
    const email = "first-time-better-auth@example.test";
    const name = "First-Time Better Auth Candidate";
    const emailSender = new CaptureEmailSender();
    const application = await createTestApplication({
      authentication: createAuthentication({
        database: testDatabase.client.database,
        config: TEST_AUTH_CONFIG,
        emailSender,
      }),
    });

    const requested = await postAuthentication(
      application,
      "/api/auth/email-otp/send-verification-otp",
      { email, type: "sign-in" },
    );
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ success: true });
    expect(emailSender.messages).toHaveLength(1);
    const firstOtp = emailSender.messages[0];
    if (firstOtp === undefined) {
      throw new Error("Better Auth did not deliver an email OTP");
    }
    expect(firstOtp).toMatchObject({
      recipient: email,
      purpose: "sign-in",
      expiresInSeconds: 5 * 60,
    });
    expect(firstOtp.code).toMatch(/^\d{6}$/u);

    const accountBeforeSignIn = await testDatabase.pool.query<{
      user_count: string;
      session_count: string;
    }>(
      `select (select count(*)::text from "user" where email = $1) as user_count,
              (
                select count(*)::text
                  from session
                  join "user" on "user".id = session.user_id
                 where "user".email = $1
              ) as session_count`,
      [email],
    );
    expect(accountBeforeSignIn.rows[0]).toEqual({ user_count: "0", session_count: "0" });

    const signedIn = await postAuthentication(application, "/api/auth/sign-in/email-otp", {
      email,
      otp: firstOtp.code,
      name,
    });
    expect(signedIn.status).toBe(200);
    const signedInBody = (await signedIn.json()) as {
      readonly token: string;
      readonly user: { readonly id: string; readonly email: string; readonly name: string };
    };
    expect(signedInBody.user).toMatchObject({ email, name });
    const firstCookie = requiredSessionCookie(signedIn);
    expect(firstCookie.header).toContain("HttpOnly");
    expect(firstCookie.header).toContain("SameSite=Lax");
    expect(firstCookie.header).toContain("Path=/");

    expect(
      (
        await apiFetchWithCookie(
          application,
          `${BETTER_AUTH_SESSION_COOKIE_NAME}=invalid-session-cookie`,
          "/api/v1/account",
        )
      ).status,
    ).toBe(401);

    const protectedAccount = await apiFetchWithCookie(
      application,
      firstCookie.cookie,
      "/api/v1/account",
    );
    expect(protectedAccount.status).toBe(200);
    expect(await protectedAccount.json()).toMatchObject({
      email,
      displayName: name,
      linkedIdentities: [{ provider: "email_otp", providerAccountId: email }],
      sessions: [expect.objectContaining({ current: true })],
    });

    const createdAccount = await testDatabase.pool.query<{
      id: string;
      name: string;
      email: string;
      email_verified: boolean;
      session_id: string;
      token: string;
      expires_at: Date;
    }>(
      `select "user".id,
              "user".name,
              "user".email,
              "user".email_verified,
              session.id as session_id,
              session.token,
              session.expires_at
         from "user"
         join session on session.user_id = "user".id
        where "user".email = $1
          and session.token = $2`,
      [email, signedInBody.token],
    );
    expect(createdAccount.rows).toHaveLength(1);
    expect(createdAccount.rows[0]).toMatchObject({
      id: signedInBody.user.id,
      name,
      email,
      email_verified: true,
      token: signedInBody.token,
    });
    expect(createdAccount.rows[0]?.session_id).toBeTruthy();
    expect(createdAccount.rows[0]?.expires_at.getTime()).toBeGreaterThan(
      (await databaseNow(testDatabase)).getTime(),
    );

    const expired = await testDatabase.pool.query(
      `update session
          set expires_at = statement_timestamp() - interval '1 second'
        where token = $1`,
      [signedInBody.token],
    );
    expect(expired.rowCount).toBe(1);
    expect(
      (await apiFetchWithCookie(application, firstCookie.cookie, "/api/v1/account")).status,
    ).toBe(401);

    const requestedAgain = await postAuthentication(
      application,
      "/api/auth/email-otp/send-verification-otp",
      { email, type: "sign-in" },
    );
    expect(requestedAgain.status).toBe(200);
    expect(emailSender.messages).toHaveLength(2);
    const secondOtp = emailSender.messages[1];
    if (secondOtp === undefined) {
      throw new Error("Better Auth did not deliver the second email OTP");
    }
    const signedInAgain = await postAuthentication(application, "/api/auth/sign-in/email-otp", {
      email,
      otp: secondOtp.code,
    });
    expect(signedInAgain.status).toBe(200);
    const signedInAgainBody = (await signedInAgain.json()) as { readonly token: string };
    const secondCookie = requiredSessionCookie(signedInAgain);
    expect(
      (await apiFetchWithCookie(application, secondCookie.cookie, "/api/v1/account")).status,
    ).toBe(200);

    const revoked = await testDatabase.pool.query(`delete from session where token = $1`, [
      signedInAgainBody.token,
    ]);
    expect(revoked.rowCount).toBe(1);
    expect(
      (await apiFetchWithCookie(application, secondCookie.cookie, "/api/v1/account")).status,
    ).toBe(401);
  }, 45_000);

  it("requires live sessions for protected command, read, SSE, and deletion access", async () => {
    const interviewer = new BlockingFauxInterviewerTextModel();
    const application = await createTestApplication({ interviewer });

    const unauthenticated = await Promise.all([
      apiFetch(application, null, "/api/v1/interviews", {
        method: "POST",
        headers: jsonCommandHeaders("unauthenticated-create"),
        body: JSON.stringify({ questionCount: 5, expectedVersion: 0 }),
      }),
      apiFetch(application, null, "/api/v1/account"),
      apiFetch(application, null, "/api/v1/operations/missing-operation/events", {
        headers: { accept: "text/event-stream" },
      }),
      apiFetch(application, null, "/api/v1/interviews/missing-interview", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      }),
      apiFetch(application, null, "/api/v1/account", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      }),
    ]);
    for (const response of unauthenticated) {
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
    }

    expect((await apiFetch(application, OWNER, "/api/v1/account")).status).toBe(200);
    await testDatabase.pool.query(
      `update session
          set expires_at = statement_timestamp() - interval '1 second'
        where id = $1`,
      [OWNER.sessionId],
    );
    expect((await apiFetch(application, OWNER, "/api/v1/account")).status).toBe(401);

    expect((await apiFetch(application, OTHER, "/api/v1/account")).status).toBe(200);
    await testDatabase.pool.query(`delete from session where id = $1`, [OTHER.sessionId]);
    const revokedCommand = await postCommand(
      application,
      OTHER,
      "/api/v1/interviews",
      "revoked-create",
      { questionCount: 5, expectedVersion: 0 },
    );
    expect(revokedCommand.response.status).toBe(401);

    const created = await createInterview(application, THIRD, "revoked-stream");
    const blockingCall = interviewer.queueCall();
    const clarification = await postCommand(
      application,
      THIRD,
      `/api/v1/interviews/${created.interviewId}/clarifications`,
      "revoked-stream-clarification",
      { expectedVersion: 1 },
    );
    expect(clarification.response.status).toBe(202);
    const operationId = operationBody(clarification.body).operationId;
    await withTimeout(blockingCall.started, "revoked SSE model start");
    const stream = await withTimeout(
      apiFetch(application, THIRD, `/api/v1/operations/${operationId}/events`, {
        headers: { accept: "text/event-stream" },
      }),
      "revoked SSE connection",
    );
    expect(stream.status).toBe(200);

    await testDatabase.pool.query(`delete from session where id = $1`, [THIRD.sessionId]);
    await withTimeout(settled(stream.text()), "revoked SSE closure");
    expect((await apiFetch(application, THIRD, `/api/v1/operations/${operationId}`)).status).toBe(
      401,
    );

    blockingCall.release("请说明当前问题的核心机制和适用边界。");
    await withTimeout(application.supervisor.drain(), "revoked operation completion");
  }, 45_000);

  it("returns indistinguishable 404 responses for another account's resources", async () => {
    const application = await createTestApplication();
    const secret = "OWNER_ONLY_ANSWER_7_15";
    const terminal = await createEarlyEndedInterview(application, OWNER, "ownership", secret);
    const active = await createInterview(application, OWNER, "ownership-active");

    const ownerDetail = await apiFetch(
      application,
      OWNER,
      `/api/v1/interviews/${terminal.interviewId}`,
    );
    expect(ownerDetail.status).toBe(200);
    expect(await ownerDetail.text()).toContain(secret);
    expect(
      (await apiFetch(application, OWNER, `/api/v1/interviews/${terminal.interviewId}/report`))
        .status,
    ).toBe(200);
    expect(
      (await apiFetch(application, OWNER, `/api/v1/operations/${terminal.reportOperationId}`))
        .status,
    ).toBe(200);

    const comparisons = [
      await compareMissingResponses(
        application,
        OTHER,
        `/api/v1/interviews/${terminal.interviewId}`,
        "/api/v1/interviews/missing-ownership-interview",
      ),
      await compareMissingResponses(
        application,
        OTHER,
        `/api/v1/interviews/${terminal.interviewId}/report`,
        "/api/v1/interviews/missing-ownership-interview/report",
      ),
      await compareMissingResponses(
        application,
        OTHER,
        `/api/v1/operations/${terminal.reportOperationId}`,
        "/api/v1/operations/missing-ownership-operation",
      ),
      await compareMissingResponses(
        application,
        OTHER,
        `/api/v1/operations/${terminal.reportOperationId}/events`,
        "/api/v1/operations/missing-ownership-operation/events",
        { headers: { accept: "text/event-stream" } },
      ),
      await compareMissingResponses(
        application,
        OTHER,
        `/api/v1/interviews/${terminal.interviewId}`,
        "/api/v1/interviews/missing-ownership-interview",
        {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        },
      ),
    ];
    for (const body of comparisons) {
      expect(body).not.toContain(secret);
      expect(body).not.toContain(OWNER.email);
    }

    const foreignHistory = await apiFetch(application, OTHER, "/api/v1/interviews");
    expect(foreignHistory.status).toBe(200);
    const foreignHistoryBody = await foreignHistory.text();
    expect(foreignHistoryBody).not.toContain(terminal.interviewId);
    expect(foreignHistoryBody).not.toContain(active.interviewId);

    const foreignActive = await apiFetch(application, OTHER, "/api/v1/interviews/active");
    expect(foreignActive.status).toBe(404);
    expect(await foreignActive.text()).not.toContain(active.interviewId);

    const activeBeforeMutation = await interviewDetail(application, OWNER, active.interviewId);
    const foreignMutation = await postCommand(
      application,
      OTHER,
      `/api/v1/interviews/${active.interviewId}/unknown`,
      "ownership-foreign-mutation",
      { expectedVersion: 1 },
    );
    const missingMutation = await postCommand(
      application,
      OTHER,
      "/api/v1/interviews/missing-ownership-interview/unknown",
      "ownership-missing-mutation",
      { expectedVersion: 1 },
    );
    expect(foreignMutation.response.status).toBe(404);
    expect(missingMutation.response.status).toBe(404);
    expect(foreignMutation.body).toEqual(missingMutation.body);

    expect(
      (await apiFetch(application, OWNER, `/api/v1/interviews/${terminal.interviewId}`)).status,
    ).toBe(200);
    expect(await interviewDetail(application, OWNER, active.interviewId)).toEqual(
      activeBeforeMutation,
    );
  }, 30_000);

  it("replays duplicate commands once and rejects idempotency-key mismatches stably", async () => {
    const application = await createTestApplication();
    const firstCreate = await postCommand(
      application,
      OWNER,
      "/api/v1/interviews",
      "idempotent-create",
      { questionCount: 5, expectedVersion: 0 },
    );
    const duplicateCreate = await postCommand(
      application,
      OWNER,
      "/api/v1/interviews",
      "idempotent-create",
      { questionCount: 5, expectedVersion: 0 },
    );
    expect(firstCreate.response.status).toBe(200);
    expect(duplicateCreate.response.status).toBe(200);
    expect(duplicateCreate.body).toEqual(firstCreate.body);
    const interviewId = operationBody(firstCreate.body).result?.interviewId;
    if (interviewId === undefined) {
      throw new Error("Create Operation did not return an interview ID");
    }

    const firstUnknown = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${interviewId}/unknown`,
      "idempotent-progress",
      { expectedVersion: 1 },
    );
    const duplicateUnknown = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${interviewId}/unknown`,
      "idempotent-progress",
      { expectedVersion: 1 },
    );
    expect(firstUnknown.response.status).toBe(200);
    expect(duplicateUnknown.response.status).toBe(200);
    expect(duplicateUnknown.body).toEqual(firstUnknown.body);

    const detail = await interviewDetail(application, OWNER, interviewId);
    expect(detail).toMatchObject({ version: 2, phase: "awaiting_continue" });
    const aggregate = await requiredInterview(interviewId, OWNER.accountId);
    expect(aggregate.questions[0]?.outcome).toMatchObject({ kind: "unknown" });

    const crossCommand = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${interviewId}/skip`,
      "idempotent-progress",
      { expectedVersion: 2 },
    );
    const repeatedCrossCommand = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${interviewId}/skip`,
      "idempotent-progress",
      { expectedVersion: 2 },
    );
    const mismatchedReplay = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${interviewId}/unknown`,
      "idempotent-progress",
      { expectedVersion: 2 },
    );
    expect(crossCommand.response.status).toBe(409);
    expect(repeatedCrossCommand.response.status).toBe(409);
    expect(mismatchedReplay.response.status).toBe(409);
    expect(repeatedCrossCommand.body).toEqual(crossCommand.body);
    expect(mismatchedReplay.body).toEqual(crossCommand.body);
    expect(crossCommand.body).toEqual({
      error: {
        code: "command_rejected",
        message: "The interview does not accept this command in its current state.",
      },
    });
    expect(await interviewDetail(application, OWNER, interviewId)).toEqual(detail);
  }, 30_000);

  it("replays in-flight clarification and answer commands as one Operation and one result", async () => {
    const interviewer = new BlockingFauxInterviewerTextModel();
    const evaluator = new BlockingFauxAnswerEvaluationModel();
    const application = await createTestApplication({ interviewer, evaluator });
    const created = await createInterview(application, OWNER, "in-flight-idempotency");

    const clarificationCall = interviewer.queueCall();
    const firstClarification = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/clarifications`,
      "in-flight-clarification",
      { expectedVersion: 1 },
    );
    expect(firstClarification.response.status).toBe(202);
    await withTimeout(clarificationCall.started, "in-flight clarification model start");
    const duplicateClarification = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/clarifications`,
      "in-flight-clarification",
      { expectedVersion: 1 },
    );
    expect(duplicateClarification.response.status).toBe(202);
    expect(duplicateClarification.body).toEqual(firstClarification.body);
    expect(interviewer.requests).toHaveLength(1);

    const clarificationText = "只应持久化一次的澄清说明。";
    clarificationCall.release(clarificationText);
    await withTimeout(application.supervisor.drain(), "in-flight clarification completion");
    const clarificationOperationId = operationBody(firstClarification.body).operationId;
    const clarificationEvents = await operationEvents(application, OWNER, clarificationOperationId);
    expect(clarificationEvents.filter((event) => event.type === "succeeded")).toHaveLength(1);
    expect(await requiredOperation(clarificationOperationId, OWNER.accountId)).toMatchObject({
      status: "succeeded",
      result: { interviewId: created.interviewId, interviewVersion: 2 },
    });
    expect(
      countMessages(
        await interviewDetail(application, OWNER, created.interviewId),
        "clarification",
        clarificationText,
      ),
    ).toBe(1);
    expect(await operationCount(OWNER.accountId, "in-flight-clarification")).toBe(1);

    const answerCall = evaluator.queueCall();
    const answerText = "只应持久化一次的候选人回答。";
    const firstAnswer = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/answers`,
      "in-flight-answer",
      { expectedVersion: 2, text: answerText },
    );
    expect(firstAnswer.response.status).toBe(202);
    await withTimeout(answerCall.started, "in-flight answer model start");
    const duplicateAnswer = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/answers`,
      "in-flight-answer",
      { expectedVersion: 2, text: answerText },
    );
    expect(duplicateAnswer.response.status).toBe(202);
    expect(duplicateAnswer.body).toEqual(firstAnswer.body);
    expect(evaluator.requests).toHaveLength(1);

    answerCall.release();
    await withTimeout(application.supervisor.drain(), "in-flight answer completion");
    const answerOperationId = operationBody(firstAnswer.body).operationId;
    const answerEvents = await operationEvents(application, OWNER, answerOperationId);
    expect(answerEvents.filter((event) => event.type === "succeeded")).toHaveLength(1);
    expect(await requiredOperation(answerOperationId, OWNER.accountId)).toMatchObject({
      status: "succeeded",
      result: { interviewId: created.interviewId, interviewVersion: 3 },
    });
    expect(
      countMessages(
        await interviewDetail(application, OWNER, created.interviewId),
        "answer",
        answerText,
      ),
    ).toBe(1);
    expect(await operationCount(OWNER.accountId, "in-flight-answer")).toBe(1);
  }, 45_000);

  it("rejects a different answer payload under the same in-flight idempotency key", async () => {
    const evaluator = new BlockingFauxAnswerEvaluationModel();
    const application = await createTestApplication({ evaluator });
    const created = await createInterview(application, OWNER, "answer-payload-mismatch");
    const evaluationCall = evaluator.queueCall();
    const originalText = "原始回答只能被接受和评估一次。";
    const mismatchedText = "相同幂等键下不应接受这段不同回答。";
    const idempotencyKey = "answer-payload-mismatch";

    const firstAnswer = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/answers`,
      idempotencyKey,
      { expectedVersion: 1, text: originalText },
    );
    expect(firstAnswer.response.status).toBe(202);
    await withTimeout(evaluationCall.started, "mismatched answer model start");

    const firstMismatch = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/answers`,
      idempotencyKey,
      { expectedVersion: 1, text: mismatchedText },
    );
    const repeatedMismatch = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/answers`,
      idempotencyKey,
      { expectedVersion: 1, text: mismatchedText },
    );
    expect(firstMismatch.response.status).toBe(409);
    expect(repeatedMismatch.response.status).toBe(409);
    expect(repeatedMismatch.body).toEqual(firstMismatch.body);
    expect(firstMismatch.body).toEqual({
      error: {
        code: "command_rejected",
        message: "The interview does not accept this command in its current state.",
      },
    });
    expect(evaluator.requests).toHaveLength(1);

    const operationId = operationBody(firstAnswer.body).operationId;
    const operationWhileProcessing = await requiredOperation(operationId, OWNER.accountId);
    expect(operationWhileProcessing).toMatchObject({
      status: "processing",
      expectedVersion: 1,
      input: { questionPosition: 1, text: originalText },
    });
    const processingDetail = await interviewDetail(application, OWNER, created.interviewId);
    expect(countMessages(processingDetail, "answer", originalText)).toBe(0);
    expect(countMessages(processingDetail, "answer", mismatchedText)).toBe(0);

    evaluationCall.release();
    await withTimeout(application.supervisor.drain(), "mismatched answer completion");
    expect(evaluator.requests).toHaveLength(1);
    expect(evaluator.requests[0]?.answerMaterial.map((material) => material.text)).toEqual([
      originalText,
    ]);
    expect(await requiredOperation(operationId, OWNER.accountId)).toMatchObject({
      status: "succeeded",
      input: { questionPosition: 1, text: originalText },
    });
    const completedDetail = await interviewDetail(application, OWNER, created.interviewId);
    expect(countMessages(completedDetail, "answer", originalText)).toBe(1);
    expect(countMessages(completedDetail, "answer", mismatchedText)).toBe(0);
    expect(await operationCount(OWNER.accountId, idempotencyKey)).toBe(1);
  }, 45_000);

  it("blocks simultaneous commands on the real account-row lock before one version wins", async () => {
    const application = await createTestApplication();
    const created = await createInterview(application, OWNER, "concurrency");
    const lockConnection = await testDatabase.pool.connect();
    const witnessConnection = await testDatabase.pool.connect();
    let transactionOpen = false;
    type CommandResult = Awaited<ReturnType<typeof postCommand>>;
    let issuedRequests: readonly Promise<CommandResult>[] = [];
    let settledRequests: readonly PromiseSettledResult<CommandResult>[] = [];
    try {
      await lockConnection.query("begin");
      transactionOpen = true;
      await lockConnection.query(
        `set local application_name = '${OPERATION_ACCOUNT_LOCK_HOLDER_APPLICATION_NAME}'`,
      );
      const lockBackend = await lockConnection.query<{ pid: number }>(
        `select pg_backend_pid() as pid`,
      );
      const lockBackendPid = lockBackend.rows[0]?.pid;
      if (lockBackendPid === undefined) {
        throw new Error("PostgreSQL did not return the account-lock holder backend PID");
      }
      await lockConnection.query(`select id from "user" where id = $1 for update`, [
        OWNER.accountId,
      ]);

      const unknownRequest = postCommand(
        application,
        OWNER,
        `/api/v1/interviews/${created.interviewId}/unknown`,
        "concurrent-unknown",
        { expectedVersion: 1 },
      );
      const skipRequest = postCommand(
        application,
        OWNER,
        `/api/v1/interviews/${created.interviewId}/skip`,
        "concurrent-skip",
        { expectedVersion: 1 },
      );
      issuedRequests = [unknownRequest, skipRequest];

      let lockWitness: readonly {
        readonly pid: number;
        readonly query: string;
        readonly waiting_lock_types: readonly string[];
        readonly blocker_pids: readonly number[];
      }[] = [];
      await waitFor(
        async () => {
          const witnessed = await witnessConnection.query<{
            pid: number;
            query: string;
            waiting_lock_types: string[];
            blocker_pids: number[];
          }>(OPERATION_ACCOUNT_LOCK_WITNESS_QUERY, [lockBackendPid]);
          lockWitness = witnessed.rows;
          return new Set(lockWitness.map((waiting) => waiting.pid)).size === 2;
        },
        "two HTTP Operation commands waiting on the account-row lock",
        10_000,
        20,
      );
      expect(lockWitness).toHaveLength(2);
      expect(lockWitness.every((waiting) => waiting.waiting_lock_types.length > 0)).toBe(true);
      expect(lockWitness.every((waiting) => waiting.blocker_pids.includes(lockBackendPid))).toBe(
        true,
      );
    } finally {
      try {
        if (transactionOpen) {
          await lockConnection.query("rollback");
          transactionOpen = false;
        }
      } finally {
        settledRequests = await Promise.allSettled(issuedRequests);
        witnessConnection.release();
        lockConnection.release();
      }
    }

    const [unknownResult, skipResult] = settledRequests;
    if (unknownResult === undefined || skipResult === undefined) {
      throw new Error("Concurrent command results were unavailable");
    }
    if (unknownResult.status === "rejected") {
      throw unknownResult.reason;
    }
    if (skipResult.status === "rejected") {
      throw skipResult.reason;
    }
    const unknown = unknownResult.value;
    const skipped = skipResult.value;
    expect([unknown.response.status, skipped.response.status].sort()).toEqual([200, 409]);
    const conflict = unknown.response.status === 409 ? unknown.body : skipped.body;
    expect(conflict).toEqual({
      error: {
        code: "version_conflict",
        message: "Interview state changed; reload the canonical state and retry.",
        interviewId: created.interviewId,
        currentVersion: 2,
        currentState: { status: "active", phase: "awaiting_continue" },
      },
    });

    const detail = await interviewDetail(application, OWNER, created.interviewId);
    expect(detail).toMatchObject({
      version: 2,
      status: "active",
      phase: "awaiting_continue",
    });
    const aggregate = await requiredInterview(created.interviewId, OWNER.accountId);
    expect(aggregate.version).toBe(2);
    expect(["unknown", "skipped"]).toContain(aggregate.questions[0]?.outcome?.kind);
    expect(aggregate.questions.filter((question) => question.outcome !== null)).toHaveLength(1);
  }, 30_000);

  it("persists lazy expiry on the first read or mutation and never creates a report", async () => {
    const application = await createTestApplication();
    const readFirst = await createInterview(application, OWNER, "expiry-read");
    const mutationFirst = await createInterview(application, OTHER, "expiry-mutation");
    await testDatabase.pool.query(
      `update interview_sessions
          set created_at = statement_timestamp() - interval '26 hours',
              last_effective_activity_at = statement_timestamp() - interval '25 hours'
        where id = any($1::text[])`,
      [[readFirst.interviewId, mutationFirst.interviewId]],
    );

    expect(await interviewDetail(application, OWNER, readFirst.interviewId)).toMatchObject({
      id: readFirst.interviewId,
      status: "abandoned",
      version: 2,
    });
    expect((await apiFetch(application, OWNER, "/api/v1/interviews/active")).status).toBe(404);
    const readFirstMutation = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${readFirst.interviewId}/unknown`,
      "expired-read-mutation",
      { expectedVersion: 2 },
    );
    expect(readFirstMutation.response.status).toBe(409);
    expect(readFirstMutation.body).toMatchObject({ error: { code: "command_rejected" } });

    const firstMutation = await postCommand(
      application,
      OTHER,
      `/api/v1/interviews/${mutationFirst.interviewId}/unknown`,
      "expired-first-mutation",
      { expectedVersion: 1 },
    );
    expect(firstMutation.response.status).toBe(409);
    expect(firstMutation.body).toMatchObject({ error: { code: "command_rejected" } });
    expect(await interviewDetail(application, OTHER, mutationFirst.interviewId)).toMatchObject({
      id: mutationFirst.interviewId,
      status: "abandoned",
      version: 2,
    });

    for (const [account, interviewId] of [
      [OWNER, readFirst.interviewId],
      [OTHER, mutationFirst.interviewId],
    ] as const) {
      expect(
        (await apiFetch(application, account, `/api/v1/interviews/${interviewId}/report`)).status,
      ).toBe(404);
    }
  }, 30_000);

  it("keeps completed, early-ended, and abandoned histories immutable after rejected commands", async () => {
    const application = await createTestApplication();
    const completed = await createCompletedInterview(application, OWNER, "terminal-completed");
    const earlyEnded = await createEarlyEndedInterview(application, OTHER, "terminal-early");
    const abandoned = await createAbandonedInterview(application, THIRD, "terminal-abandoned");
    const terminal = [
      {
        account: OWNER,
        interviewId: completed.interviewId,
        path: "answers",
        payload: { expectedVersion: completed.version, text: "不得写入的完成后回答" },
      },
      {
        account: OTHER,
        interviewId: earlyEnded.interviewId,
        path: "supplements",
        payload: { expectedVersion: earlyEnded.version, text: "不得写入的提前结束后补充" },
      },
      {
        account: THIRD,
        interviewId: abandoned.interviewId,
        path: "clarifications",
        payload: { expectedVersion: abandoned.version },
      },
    ] as const;
    const before = await Promise.all(
      terminal.map(async ({ account, interviewId }) => ({
        detail: await interviewDetail(application, account, interviewId),
        history: await jsonBody(await apiFetch(application, account, "/api/v1/interviews")),
      })),
    );
    const modelRequestCounts = {
      evaluator: application.evaluator.requests.length,
      interviewer: application.interviewer.requests.length,
      reportAnalyzer: application.reportAnalyzer.requests.length,
    };

    for (const [index, target] of terminal.entries()) {
      const rejected = await postCommand(
        application,
        target.account,
        `/api/v1/interviews/${target.interviewId}/${target.path}`,
        `terminal-rejection-${index}`,
        target.payload,
      );
      expect(rejected.response.status).toBe(409);
      expect(rejected.body).toMatchObject({ error: { code: "command_rejected" } });
    }

    for (const [index, { account, interviewId }] of terminal.entries()) {
      expect(await interviewDetail(application, account, interviewId)).toEqual(
        before[index]?.detail,
      );
      expect(await jsonBody(await apiFetch(application, account, "/api/v1/interviews"))).toEqual(
        before[index]?.history,
      );
    }
    expect(application.evaluator.requests).toHaveLength(modelRequestCounts.evaluator);
    expect(application.interviewer.requests).toHaveLength(modelRequestCounts.interviewer);
    expect(application.reportAnalyzer.requests).toHaveLength(modelRequestCounts.reportAnalyzer);
  }, 45_000);

  it("continues blocked execution after command and SSE disconnects and recovers after replay loss", async () => {
    const interviewer = new BlockingFauxInterviewerTextModel();
    const application = await createTestApplication({ interviewer });
    const created = await createInterview(application, OWNER, "disconnect");
    const call = interviewer.queueCall();

    const responseStatus = await disconnectCommandAfterHeaders(
      application,
      OWNER,
      `/api/v1/interviews/${created.interviewId}/clarifications`,
      "disconnect-clarification",
      { expectedVersion: 1 },
    );
    expect(responseStatus).toBe(202);
    await withTimeout(call.started, "disconnected command model start");
    const processing = await operationRepository.findLatestIncompleteByInterviewId(
      parseInterviewId(created.interviewId),
      OWNER.accountId,
    );
    expect(processing).toMatchObject({
      status: "processing",
      type: "request_question_clarification",
    });
    if (processing === null) {
      throw new Error("Disconnected command did not persist a processing Operation");
    }
    expect(await interviewDetail(application, OWNER, created.interviewId)).toMatchObject({
      version: 2,
      phase: "processing",
      messages: [expect.objectContaining({ kind: "main_question" })],
    });

    const disconnectedStream = await withTimeout(
      apiFetch(application, OWNER, `/api/v1/operations/${processing.id}/events`, {
        headers: { accept: "text/event-stream" },
      }),
      "disconnected SSE response",
    );
    expect(disconnectedStream.status).toBe(200);
    await disconnectedStream.body?.cancel();
    await waitFor(
      () => application.broker.listenerCount(processing) === 0,
      "disconnected SSE listener cleanup",
    );

    const recoveredStream = await withTimeout(
      apiFetch(application, OWNER, `/api/v1/operations/${processing.id}/events`, {
        headers: { accept: "text/event-stream" },
      }),
      "recovered SSE response",
    );
    expect(recoveredStream.status).toBe(200);
    const recoveredBody = withTimeout(recoveredStream.text(), "recovered SSE terminal body");
    const clarification = "请围绕当前问题说明核心机制、适用边界以及调用链影响。";
    call.release(clarification);
    const events = parseSse(await recoveredBody);
    expect(events.map((event) => event.event)).toEqual(["text_delta", "succeeded"]);
    expect(events.every((event) => Check(OperationEventSchema, event.data))).toBe(true);
    expect(events[0]?.data).toMatchObject({ type: "text_delta", text: clarification });
    await waitFor(
      () => application.broker.listenerCount(processing) === 0,
      "terminal SSE listener cleanup",
    );

    const canonicalOperation = await apiFetch(
      application,
      OWNER,
      `/api/v1/operations/${processing.id}`,
    );
    expect(canonicalOperation.status).toBe(200);
    expect(await canonicalOperation.json()).toMatchObject({
      operationId: String(processing.id),
      status: "succeeded",
      result: { interviewId: created.interviewId, interviewVersion: 2 },
    });
    expect(await interviewDetail(application, OWNER, created.interviewId)).toMatchObject({
      version: 2,
      status: "active",
      phase: "awaiting_response",
      messages: expect.arrayContaining([
        expect.objectContaining({ kind: "clarification", text: clarification }),
      ]),
    });

    await closeApplication(application);
    const restarted = await createTestApplication();
    const replayHeaders = {
      accept: "text/event-stream",
      "last-event-id": "1",
    };
    const replay = await apiFetch(restarted, OWNER, `/api/v1/operations/${processing.id}/events`, {
      headers: replayHeaders,
    });
    const repeatedReplay = await apiFetch(
      restarted,
      OWNER,
      `/api/v1/operations/${processing.id}/events`,
      { headers: replayHeaders },
    );
    expect(replay.status).toBe(409);
    expect(repeatedReplay.status).toBe(409);
    expect(await repeatedReplay.json()).toEqual(await replay.json());
    expect((await apiFetch(restarted, OWNER, `/api/v1/operations/${processing.id}`)).status).toBe(
      200,
    );
    expect(
      (await apiFetch(restarted, OWNER, `/api/v1/interviews/${created.interviewId}`)).status,
    ).toBe(200);
  }, 90_000);

  it("immediately hides deleted data and closes and erases interview and account SSE state", async () => {
    const interviewer = new BlockingFauxInterviewerTextModel();
    let publisher!: PausingOperationEventPublisher;
    const application = await createTestApplication({
      interviewer,
      eventPublisher: (broker) => {
        publisher = new PausingOperationEventPublisher(broker);
        return publisher;
      },
      statusPollIntervalMs: 60_000,
    });

    const interviewTarget = await createInterview(application, OWNER, "delete-interview");
    const interviewCall = interviewer.queueCall();
    const interviewPublication = publisher.pauseNextTextAndTerminal();
    const interviewClarification = await postCommand(
      application,
      OWNER,
      `/api/v1/interviews/${interviewTarget.interviewId}/clarifications`,
      "delete-interview-clarification",
      { expectedVersion: 1 },
    );
    expect(interviewClarification.response.status).toBe(202);
    const interviewOperationId = operationBody(interviewClarification.body).operationId;
    await withTimeout(interviewCall.started, "interview deletion model start");
    const interviewOperation = await requiredOperation(interviewOperationId, OWNER.accountId);
    const interviewStream = await apiFetch(
      application,
      OWNER,
      `/api/v1/operations/${interviewOperationId}/events`,
      { headers: { accept: "text/event-stream" } },
    );
    expect(interviewStream.status).toBe(200);
    expect(application.broker.listenerCount(interviewOperation)).toBe(1);

    interviewCall.release("删除后不得重新发布此澄清文本。");
    const finalizedInterviewOperation = await withTimeout(
      interviewPublication.paused,
      "interview publication pause",
    );
    expect(finalizedInterviewOperation).toMatchObject({
      id: interviewOperation.id,
      status: "succeeded",
    });
    await withTimeout(application.supervisor.drain(), "interview operation finalization");
    expect(application.broker.history(interviewOperation)).toEqual([]);

    const deletedInterview = await apiFetch(
      application,
      OWNER,
      `/api/v1/interviews/${interviewTarget.interviewId}`,
      {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      },
    );
    expect(deletedInterview.status).toBe(202);
    await withTimeout(settled(interviewStream.text()), "interview deletion SSE closure");
    interviewPublication.release();
    expect(application.broker.listenerCount(interviewOperation)).toBe(0);
    expect(application.broker.history(interviewOperation)).toEqual([]);
    expect(
      (await apiFetch(application, OWNER, `/api/v1/interviews/${interviewTarget.interviewId}`))
        .status,
    ).toBe(404);
    expect(
      (await apiFetch(application, OWNER, `/api/v1/operations/${interviewOperationId}`)).status,
    ).toBe(404);
    expect(
      (
        await apiFetch(application, OWNER, `/api/v1/operations/${interviewOperationId}/events`, {
          headers: { accept: "text/event-stream" },
        })
      ).status,
    ).toBe(404);

    const secondAccountSession = await seedAdditionalSession(OTHER, "deletion-second");
    expect((await apiFetch(application, OTHER, "/api/v1/account")).status).toBe(200);
    expect((await apiFetch(application, secondAccountSession, "/api/v1/account")).status).toBe(200);
    const oldReport = await createEarlyEndedInterview(application, OTHER, "delete-account-report");
    const accountTarget = await createInterview(application, OTHER, "delete-account-active");
    const accountCall = interviewer.queueCall();
    const accountPublication = publisher.pauseNextTextAndTerminal();
    const accountClarification = await postCommand(
      application,
      OTHER,
      `/api/v1/interviews/${accountTarget.interviewId}/clarifications`,
      "delete-account-clarification",
      { expectedVersion: 1 },
    );
    expect(accountClarification.response.status).toBe(202);
    const accountOperationId = operationBody(accountClarification.body).operationId;
    await withTimeout(accountCall.started, "account deletion model start");
    const accountOperation = await requiredOperation(accountOperationId, OTHER.accountId);
    const reportOperation = await requiredOperation(oldReport.reportOperationId, OTHER.accountId);
    const accountStream = await apiFetch(
      application,
      OTHER,
      `/api/v1/operations/${accountOperationId}/events`,
      { headers: { accept: "text/event-stream" } },
    );
    expect(accountStream.status).toBe(200);
    const secondAccountStream = await apiFetch(
      application,
      secondAccountSession,
      `/api/v1/operations/${accountOperationId}/events`,
      { headers: { accept: "text/event-stream" } },
    );
    expect(secondAccountStream.status).toBe(200);
    expect(application.broker.listenerCount(accountOperation)).toBe(2);

    accountCall.release("账户删除后不得重新发布此澄清文本。");
    const finalizedAccountOperation = await withTimeout(
      accountPublication.paused,
      "account publication pause",
    );
    expect(finalizedAccountOperation).toMatchObject({
      id: accountOperation.id,
      status: "succeeded",
    });
    await withTimeout(application.supervisor.drain(), "account operation finalization");
    expect(application.broker.history(accountOperation)).toEqual([]);

    const deletedAccount = await apiFetch(application, OTHER, "/api/v1/account", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    expect(deletedAccount.status).toBe(202);
    await withTimeout(settled(accountStream.text()), "account deletion SSE closure");
    await withTimeout(settled(secondAccountStream.text()), "second account deletion SSE closure");
    accountPublication.release();
    expect(application.broker.listenerCount(accountOperation)).toBe(0);
    expect(application.broker.history(accountOperation)).toEqual([]);
    expect(application.broker.history(reportOperation)).toEqual([]);
    expect(await accountSessionCount(OTHER.accountId)).toBe(0);
    expect((await apiFetch(application, OTHER, "/api/v1/account")).status).toBe(401);
    expect((await apiFetch(application, secondAccountSession, "/api/v1/account")).status).toBe(401);
    expect(
      (await apiFetch(application, OTHER, `/api/v1/interviews/${oldReport.interviewId}/report`))
        .status,
    ).toBe(401);
    expect(
      (
        await apiFetch(
          application,
          secondAccountSession,
          `/api/v1/interviews/${accountTarget.interviewId}`,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await apiFetch(application, OTHER, `/api/v1/operations/${accountOperationId}/events`, {
          headers: { accept: "text/event-stream" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await apiFetch(
          application,
          secondAccountSession,
          `/api/v1/operations/${accountOperationId}/events`,
          { headers: { accept: "text/event-stream" } },
        )
      ).status,
    ).toBe(401);

    await withTimeout(application.supervisor.drain(), "deletion operation cleanup");

    expect(application.broker.listenerCount(interviewOperation)).toBe(0);
    expect(application.broker.history(interviewOperation)).toEqual([]);
    expect(application.broker.listenerCount(accountOperation)).toBe(0);
    expect(application.broker.history(accountOperation)).toEqual([]);
    expect(application.broker.history(reportOperation)).toEqual([]);
    expect(
      (await apiFetch(application, OWNER, `/api/v1/interviews/${interviewTarget.interviewId}`))
        .status,
    ).toBe(404);
    expect(
      (await apiFetch(application, OWNER, `/api/v1/operations/${interviewOperationId}`)).status,
    ).toBe(404);
    expect(
      (await apiFetch(application, OTHER, `/api/v1/interviews/${accountTarget.interviewId}`))
        .status,
    ).toBe(401);
    expect(
      (
        await apiFetch(
          application,
          secondAccountSession,
          `/api/v1/interviews/${oldReport.interviewId}/report`,
        )
      ).status,
    ).toBe(401);
  }, 90_000);
});

class FauxAnswerEvaluationModel implements AnswerEvaluationModel {
  readonly requests: AnswerEvaluationRequest[] = [];

  async evaluate(request: AnswerEvaluationRequest): Promise<AnswerEvaluationResult> {
    this.requests.push(request);
    return fullEvaluation(request);
  }
}

class BlockingFauxAnswerEvaluationModel extends FauxAnswerEvaluationModel {
  private readonly calls: BlockingEvaluationCall[] = [];

  queueCall(): {
    readonly started: Promise<AnswerEvaluationRequest>;
    readonly release: () => void;
  } {
    const call: BlockingEvaluationCall = {
      started: deferred<AnswerEvaluationRequest>(),
      completed: deferred<void>(),
      released: false,
    };
    this.calls.push(call);
    return {
      started: call.started.promise,
      release: () => releaseBlockingEvaluationCall(call),
    };
  }

  releaseAll(): void {
    for (const call of this.calls) {
      releaseBlockingEvaluationCall(call);
    }
  }

  override async evaluate(request: AnswerEvaluationRequest): Promise<AnswerEvaluationResult> {
    const call = this.calls.find((candidate) => candidate.request === undefined);
    if (call === undefined) {
      throw new Error("No blocking Faux answer evaluation was queued");
    }
    call.request = request;
    this.requests.push(request);
    call.started.resolve(request);
    await call.completed.promise;
    return fullEvaluation(request);
  }
}

class FauxInterviewerTextModel implements InterviewerTextModel {
  readonly requests: InterviewerTextRequest[] = [];

  async *stream(request: InterviewerTextRequest): AsyncIterable<InterviewerTextEvent> {
    this.requests.push(request);
    const text =
      request.purpose === "clarify_question"
        ? "请围绕当前问题说明它的核心机制和适用边界。"
        : "请进一步说明这个机制在实际调用链中的影响。";
    yield { type: "delta", text };
    yield {
      type: "completed",
      text,
      metadata: {
        ...MODEL_METADATA,
        purpose: request.purpose,
        questionVersion: request.question.questionVersion,
      },
    };
  }
}

class BlockingFauxInterviewerTextModel implements InterviewerTextModel {
  readonly requests: InterviewerTextRequest[] = [];
  private readonly calls: BlockingCall[] = [];

  queueCall(): {
    readonly started: Promise<InterviewerTextRequest>;
    readonly release: (text: string) => void;
  } {
    const call: BlockingCall = {
      started: deferred<InterviewerTextRequest>(),
      completed: deferred<string>(),
      released: false,
    };
    this.calls.push(call);
    return {
      started: call.started.promise,
      release: (text) => releaseBlockingCall(call, text),
    };
  }

  releaseAll(): void {
    for (const call of this.calls) {
      releaseBlockingCall(call, "请说明当前问题的核心机制和适用边界。");
    }
  }

  async *stream(request: InterviewerTextRequest): AsyncIterable<InterviewerTextEvent> {
    const call = this.calls.find((candidate) => candidate.request === undefined);
    if (call === undefined) {
      throw new Error("No blocking Faux interviewer response was queued");
    }
    call.request = request;
    this.requests.push(request);
    call.started.resolve(request);
    const text = await call.completed.promise;
    yield { type: "delta", text };
    yield {
      type: "completed",
      text,
      metadata: {
        ...MODEL_METADATA,
        purpose: request.purpose,
        questionVersion: request.question.questionVersion,
      },
    };
  }
}

class FauxReportAnalysisModel implements ReportAnalysisModel {
  readonly requests: ReportAnalysisRequest[] = [];

  async analyze(request: ReportAnalysisRequest): Promise<ReportAnalysisResult> {
    this.requests.push(request);
    return fullReportAnalysis(request);
  }
}

class PausingOperationEventPublisher implements OperationEventPublisher {
  private nextTextAndTerminalPause: PublicationPause | null = null;

  constructor(private readonly delegate: OperationEventPublisher) {}

  pauseNextTextAndTerminal(): {
    readonly paused: Promise<StoredOperation>;
    readonly release: () => void;
  } {
    if (this.nextTextAndTerminalPause !== null) {
      throw new Error("An Operation publication pause is already queued");
    }
    const pause: PublicationPause = {
      paused: deferred<StoredOperation>(),
      released: false,
    };
    this.nextTextAndTerminalPause = pause;
    return {
      paused: pause.paused.promise,
      release: () => {
        if (pause.released) {
          return;
        }
        pause.released = true;
        pause.publish?.();
      },
    };
  }

  beginAttempt(operation: StoredOperation): void {
    this.delegate.beginAttempt(operation);
  }

  publishTextDelta(operation: StoredOperation, text: string, occurredAt: Date) {
    return this.delegate.publishTextDelta(operation, text, occurredAt);
  }

  publishTextAndTerminal(operation: StoredOperation, text: string, occurredAt: Date) {
    const pause = this.nextTextAndTerminalPause;
    if (pause === null) {
      return this.delegate.publishTextAndTerminal(operation, text, occurredAt);
    }
    this.nextTextAndTerminalPause = null;
    pause.publish = () => {
      this.delegate.publishTextAndTerminal(operation, text, occurredAt);
    };
    pause.paused.resolve(operation);
    if (pause.released) {
      pause.publish();
    }
    return null;
  }

  publishTerminal(operation: StoredOperation, continuityUnknown?: boolean) {
    return this.delegate.publishTerminal(operation, continuityUnknown);
  }
}

class CaptureEmailSender implements EmailSender {
  readonly messages: VerificationOtpEmail[] = [];

  async sendVerificationOtp(message: VerificationOtpEmail): Promise<void> {
    this.messages.push({ ...message });
  }
}

interface TestAccount {
  readonly accountId: AccountId;
  readonly email: string;
  readonly name: string;
  readonly sessionId: string;
  readonly token: string;
}

interface TestApplication {
  readonly address: string;
  readonly app: ReturnType<typeof createServer>;
  readonly broker: OperationEventBroker;
  readonly evaluator: AnswerEvaluationModel & {
    readonly requests: readonly AnswerEvaluationRequest[];
    releaseAll?(): void;
  };
  readonly interviewer: InterviewerTextModel & {
    readonly requests: InterviewerTextRequest[];
    releaseAll?(): void;
  };
  readonly reportAnalyzer: FauxReportAnalysisModel;
  readonly supervisor: ServerOwnedOperationSupervisor;
  closed: boolean;
}

interface OperationResponseBody {
  readonly operationId: string;
  readonly status: string;
  readonly result?: {
    readonly interviewId?: string;
    readonly interviewVersion?: number;
    readonly reportId?: string | null;
  };
}

interface InterviewResponseBody {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly phase?: string;
  readonly messages: readonly unknown[];
}

interface BlockingCall {
  readonly started: Deferred<InterviewerTextRequest>;
  readonly completed: Deferred<string>;
  request?: InterviewerTextRequest;
  released: boolean;
}

interface BlockingEvaluationCall {
  readonly started: Deferred<AnswerEvaluationRequest>;
  readonly completed: Deferred<void>;
  request?: AnswerEvaluationRequest;
  released: boolean;
}

interface PublicationPause {
  readonly paused: Deferred<StoredOperation>;
  released: boolean;
  publish?: () => void;
}

async function createTestApplication(
  options: {
    readonly interviewer?: TestApplication["interviewer"];
    readonly evaluator?: TestApplication["evaluator"];
    readonly reportAnalyzer?: FauxReportAnalysisModel;
    readonly eventPublisher?: (broker: OperationEventBroker) => OperationEventPublisher;
    readonly statusPollIntervalMs?: number;
    readonly authentication?: Authentication;
  } = {},
): Promise<TestApplication> {
  applicationSequence += 1;
  const prefix = `api${applicationSequence}`;
  let interviewSequence = 0;
  let operationSequence = 0;
  const interviewer = options.interviewer ?? new FauxInterviewerTextModel();
  const evaluator = options.evaluator ?? new FauxAnswerEvaluationModel();
  const reportAnalyzer = options.reportAnalyzer ?? new FauxReportAnalysisModel();
  const broker = new OperationEventBroker();
  const events = options.eventPublisher?.(broker) ?? broker;
  const supervisor = new ServerOwnedOperationSupervisor();
  const handlers = new InterviewOperationHandlers(
    new OperationRunner(unitOfWork, interviewer, evaluator, reportAnalyzer, {
      leaseOwner: `${prefix}-worker`,
      events,
    }),
  );
  const defaults = createInterviewCommandRouteDependencies(
    handlers,
    {
      async findById(interviewId, accountId) {
        const interview = await unitOfWork.run((repositories) =>
          repositories.interviews.findById(interviewId, accountId),
        );
        return interview === null
          ? null
          : {
              version: interview.version,
              status: interview.status,
              phase: interview.phase,
            };
      },
    },
    supervisor,
  );
  const app = createServer({ logger: false });
  await registerApplication(app, {
    authentication: options.authentication ?? databaseSessionAuthentication(),
    config: TEST_AUTH_CONFIG,
    deletion: new DeletionOrchestrationService(
      new PgLifecycleRepository(testDatabase.client.database),
    ),
    interviewCommands: {
      ...defaults,
      nextInterviewId: () => parseInterviewId(`${prefix}-interview-${++interviewSequence}`),
      nextOperationId: () => parseOperationId(`${prefix}-operation-${++operationSequence}`),
    },
    canonicalReads: createCanonicalReadRouteDependencies(unitOfWork),
    operationEvents: {
      ...createOperationEventRouteDependencies(unitOfWork, broker),
      heartbeatIntervalMs: 20,
      statusPollIntervalMs: options.statusPollIntervalMs ?? 20,
      terminalPublicationGraceMs: 0,
    },
  });
  app.addHook("onClose", async () => {
    await supervisor.shutdown();
  });
  const application: TestApplication = {
    address: await app.listen({ host: "127.0.0.1", port: 0 }),
    app,
    broker,
    evaluator,
    interviewer,
    reportAnalyzer,
    supervisor,
    closed: false,
  };
  applications.push(application);
  return application;
}

async function closeApplication(application: TestApplication): Promise<void> {
  if (application.closed) {
    return;
  }
  application.closed = true;
  application.interviewer.releaseAll?.();
  await application.app.close();
}

function databaseSessionAuthentication(): Authentication {
  const options: BetterAuthOptions = {};
  return {
    handler: async () => new Response(null, { status: 404 }),
    options,
    async getSession(headers) {
      const authorization = headers.get("authorization");
      const token = authorization?.match(/^Bearer (.+)$/)?.[1];
      if (token === undefined) {
        return { context: null, headers: new Headers() };
      }
      const result = await testDatabase.pool.query<{
        id: string;
        user_id: string;
        email: string;
        name: string;
      }>(
        `select session.id, session.user_id, "user".email, "user".name
           from session
           join "user" on "user".id = session.user_id
          where session.token = $1
            and session.expires_at > statement_timestamp()
            and "user".deletion_requested_at is null
          limit 1`,
        [token],
      );
      const current = result.rows[0];
      return {
        headers: new Headers(),
        context:
          current === undefined
            ? null
            : {
                accountId: parseAccountId(current.user_id),
                sessionId: current.id,
                email: current.email,
                name: current.name,
              },
      };
    },
  };
}

async function seedAccounts(): Promise<void> {
  const now = await databaseNow(testDatabase);
  await testDatabase.client.database.insert(user).values(
    ACCOUNTS.map((account) => ({
      id: account.accountId,
      name: account.name,
      email: account.email,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })),
  );
  await testDatabase.client.database.insert(session).values(
    ACCOUNTS.map((account) => ({
      id: account.sessionId,
      token: account.token,
      userId: account.accountId,
      expiresAt: new Date(now.getTime() + 60 * 60_000),
      createdAt: now,
      updatedAt: now,
    })),
  );
}

async function seedAdditionalSession(account: TestAccount, suffix: string): Promise<TestAccount> {
  const now = await databaseNow(testDatabase);
  const additional = {
    ...account,
    sessionId: `${account.accountId}-${suffix}-session`,
    token: `${account.accountId}-${suffix}-token`,
  };
  await testDatabase.client.database.insert(session).values({
    id: additional.sessionId,
    token: additional.token,
    userId: account.accountId,
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    createdAt: now,
    updatedAt: now,
  });
  return additional;
}

async function seedQuestionBank(): Promise<void> {
  const entries: QuestionBankImportEntry[] = KNOWLEDGE_DOMAINS.map((domain, index) => ({
    definition: questionDefinitionFixture({
      id: `api.question.${index + 1}`,
      contentVersion: 1,
      domain,
      sourceWording: `请说明第 ${index + 1} 个 Go 后端主题中的核心机制和适用边界。`,
    }),
    schemaVersion: "1.0",
    sourceFile: `${domain}/questions.yaml`,
  }));
  await new QuestionBankImportService(
    new PgQuestionBankRepository(testDatabase.client.database),
  ).synchronize({
    sourceName: "api-integration-fixture",
    sourceVersion: 1,
    entries,
  });
}

async function createInterview(
  application: TestApplication,
  account: TestAccount,
  key: string,
): Promise<{ readonly interviewId: string; readonly operationId: string }> {
  const created = await postCommand(application, account, "/api/v1/interviews", `${key}-create`, {
    questionCount: 5,
    expectedVersion: 0,
  });
  expect(created.response.status).toBe(200);
  const body = operationBody(created.body);
  const interviewId = body.result?.interviewId;
  if (interviewId === undefined) {
    throw new Error("Create Operation did not return an interview ID");
  }
  return { interviewId, operationId: body.operationId };
}

async function createEarlyEndedInterview(
  application: TestApplication,
  account: TestAccount,
  key: string,
  answerText?: string,
): Promise<{
  readonly interviewId: string;
  readonly reportOperationId: string;
  readonly version: number;
}> {
  const created = await createInterview(application, account, key);
  if (answerText === undefined) {
    const unknown = await postCommand(
      application,
      account,
      `/api/v1/interviews/${created.interviewId}/unknown`,
      `${key}-unknown`,
      { expectedVersion: 1 },
    );
    expect(unknown.response.status).toBe(200);
  } else {
    const answer = await postCommand(
      application,
      account,
      `/api/v1/interviews/${created.interviewId}/answers`,
      `${key}-answer`,
      { expectedVersion: 1, text: answerText },
    );
    expect(answer.response.status).toBe(202);
    await operationEvents(application, account, operationBody(answer.body).operationId);
  }
  const endEarly = await postCommand(
    application,
    account,
    `/api/v1/interviews/${created.interviewId}/end-early`,
    `${key}-end-early`,
    { expectedVersion: 2 },
  );
  expect(endEarly.response.status).toBe(202);
  const reportOperationId = operationBody(endEarly.body).operationId;
  await operationEvents(application, account, reportOperationId);
  const detail = await interviewDetail(application, account, created.interviewId);
  expect(detail.status).toBe("early_ended");
  return {
    interviewId: created.interviewId,
    reportOperationId,
    version: detail.version,
  };
}

async function createCompletedInterview(
  application: TestApplication,
  account: TestAccount,
  key: string,
): Promise<{ readonly interviewId: string; readonly version: number }> {
  const created = await createInterview(application, account, key);
  let version = 1;
  for (let position = 1; position <= 5; position += 1) {
    const unknown = await postCommand(
      application,
      account,
      `/api/v1/interviews/${created.interviewId}/unknown`,
      `${key}-unknown-${position}`,
      { expectedVersion: version },
    );
    expect(unknown.response.status).toBe(200);
    version += 1;
    const continued = await postCommand(
      application,
      account,
      `/api/v1/interviews/${created.interviewId}/continue`,
      `${key}-continue-${position}`,
      { expectedVersion: version },
    );
    if (position < 5) {
      expect(continued.response.status).toBe(200);
      version += 1;
    } else {
      expect(continued.response.status).toBe(202);
      await operationEvents(application, account, operationBody(continued.body).operationId);
    }
  }
  const detail = await interviewDetail(application, account, created.interviewId);
  expect(detail.status).toBe("completed");
  return { interviewId: created.interviewId, version: detail.version };
}

async function createAbandonedInterview(
  application: TestApplication,
  account: TestAccount,
  key: string,
): Promise<{ readonly interviewId: string; readonly version: number }> {
  const created = await createInterview(application, account, key);
  const abandoned = await postCommand(
    application,
    account,
    `/api/v1/interviews/${created.interviewId}/abandon`,
    `${key}-abandon`,
    { expectedVersion: 1 },
  );
  expect(abandoned.response.status).toBe(200);
  const detail = await interviewDetail(application, account, created.interviewId);
  expect(detail.status).toBe("abandoned");
  return { interviewId: created.interviewId, version: detail.version };
}

async function apiFetch(
  application: TestApplication,
  account: TestAccount | null,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (account !== null) {
    headers.set("authorization", `Bearer ${account.token}`);
  }
  return await fetch(`${application.address}${path}`, { ...init, headers });
}

async function apiFetchWithCookie(
  application: TestApplication,
  cookie: string,
  path: string,
): Promise<Response> {
  return await fetch(`${application.address}${path}`, { headers: { cookie } });
}

async function postAuthentication(
  application: TestApplication,
  path: string,
  payload: object,
): Promise<Response> {
  return await fetch(`${application.address}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: TEST_AUTH_CONFIG.auth.baseUrl,
    },
    body: JSON.stringify(payload),
  });
}

function requiredSessionCookie(response: Response): {
  readonly header: string;
  readonly cookie: string;
} {
  const header = response.headers
    .getSetCookie()
    .find((candidate) => candidate.startsWith(`${BETTER_AUTH_SESSION_COOKIE_NAME}=`));
  if (header === undefined) {
    throw new Error("Better Auth response did not set its session cookie");
  }
  return {
    header,
    cookie: header.slice(0, header.indexOf(";")),
  };
}

async function postCommand(
  application: TestApplication,
  account: TestAccount,
  path: string,
  idempotencyKey: string,
  payload: object,
): Promise<{ readonly response: Response; readonly body: unknown }> {
  const response = await apiFetch(application, account, path, {
    method: "POST",
    headers: jsonCommandHeaders(idempotencyKey),
    body: JSON.stringify(payload),
  });
  return { response, body: await jsonBody(response) };
}

async function interviewDetail(
  application: TestApplication,
  account: TestAccount,
  interviewId: string,
): Promise<InterviewResponseBody> {
  const response = await apiFetch(application, account, `/api/v1/interviews/${interviewId}`);
  expect(response.status).toBe(200);
  return (await response.json()) as InterviewResponseBody;
}

async function operationEvents(
  application: TestApplication,
  account: TestAccount,
  operationId: string,
): Promise<readonly OperationEventDto[]> {
  const response = await withTimeout(
    apiFetch(application, account, `/api/v1/operations/${operationId}/events`, {
      headers: { accept: "text/event-stream" },
    }),
    `Operation ${operationId} SSE response`,
  );
  expect(response.status).toBe(200);
  const events = parseSse(
    await withTimeout(response.text(), `Operation ${operationId} SSE terminal body`),
  ).map((event) => event.data);
  expect(events.at(-1)?.type).toBe("succeeded");
  expect(events.every((event) => Check(OperationEventSchema, event))).toBe(true);
  return events;
}

async function compareMissingResponses(
  application: TestApplication,
  account: TestAccount,
  inaccessiblePath: string,
  missingPath: string,
  init: RequestInit = {},
): Promise<string> {
  const inaccessible = await apiFetch(application, account, inaccessiblePath, init);
  const missing = await apiFetch(application, account, missingPath, init);
  expect(inaccessible.status).toBe(404);
  expect(missing.status).toBe(404);
  const inaccessibleBody = await inaccessible.text();
  expect(inaccessibleBody).toBe(await missing.text());
  return inaccessibleBody;
}

async function disconnectCommandAfterHeaders(
  application: TestApplication,
  account: TestAccount,
  path: string,
  idempotencyKey: string,
  payload: object,
): Promise<number> {
  const url = new URL(path, application.address);
  const body = JSON.stringify(payload);
  return await withTimeout(
    new Promise<number>((resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${account.token}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            "idempotency-key": idempotencyKey,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          response.destroy();
          request.destroy();
          resolve(status);
        },
      );
      request.once("error", (error) => {
        if (!request.destroyed) {
          reject(error);
        }
      });
      request.end(body);
    }),
    "disconnected command response headers",
  );
}

async function requiredInterview(interviewId: string, accountId: AccountId) {
  const interview = await interviewRepository.findById(parseInterviewId(interviewId), accountId);
  if (interview === null) {
    throw new Error(`Missing interview ${interviewId}`);
  }
  return interview;
}

async function requiredOperation(
  operationId: string,
  accountId: AccountId,
): Promise<StoredOperation> {
  const operation = await operationRepository.findById(parseOperationId(operationId), accountId);
  if (operation === null) {
    throw new Error(`Missing Operation ${operationId}`);
  }
  return operation;
}

async function operationCount(accountId: AccountId, idempotencyKey: string): Promise<number> {
  const result = await testDatabase.pool.query<{ count: string }>(
    `select count(*)::text as count
       from operations
      where owner_user_id = $1
        and idempotency_key = $2`,
    [accountId, idempotencyKey],
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function accountSessionCount(accountId: AccountId): Promise<number> {
  const result = await testDatabase.pool.query<{ count: string }>(
    `select count(*)::text as count from session where user_id = $1`,
    [accountId],
  );
  return Number(result.rows[0]?.count ?? "0");
}

function countMessages(detail: InterviewResponseBody, kind: string, text: string): number {
  return detail.messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "kind" in message &&
      message.kind === kind &&
      "text" in message &&
      message.text === text,
  ).length;
}

function fullEvaluation(request: AnswerEvaluationRequest): AnswerEvaluationResult {
  const evidence = request.answerMaterial.at(-1)?.id;
  return {
    classification: "relevant",
    rubricItems: request.question.rubric.map((item) => ({
      rubricItemId: item.id,
      evidenceMaterialIds: evidence === undefined ? [] : [evidence],
      awardedPoints: item.weight,
      missingOrIncorrectPoints: [],
    })),
    recommendedFollowUpGoal: null,
    metadata: {
      ...MODEL_METADATA,
      questionVersion: request.question.questionVersion,
    },
  };
}

function fullReportAnalysis(request: ReportAnalysisRequest): ReportAnalysisResult {
  return {
    overallExplanation: "本次回答体现了已完成题目的知识掌握情况。",
    strengths: ["能够围绕问题说明核心机制。"],
    weaknesses: ["部分知识点仍需要进一步巩固。"],
    priorities: ["优先复习未掌握或未作答的知识点。"],
    learningSuggestions: ["结合实际场景复盘相关机制。"],
    perQuestion: request.questions.map(({ question, evaluation }) => ({
      questionId: question.questionId,
      answerSummary:
        evaluation === null ? "该题没有可用于评分的作答。" : "回答覆盖了已记录的知识点。",
      scoreRationale:
        evaluation === null ? "该题按已记录的未作答结果处理。" : "结论依据已保存的结构化评估结果。",
      improvementSuggestions: ["针对缺失知识点进行复习并结合场景练习。"],
      evidenceMaterialIds:
        evaluation === null
          ? []
          : [...new Set(evaluation.rubricItems.flatMap((item) => item.evidenceMaterialIds))],
    })),
    metadata: {
      ...MODEL_METADATA,
      purpose: "report_analysis",
      questionVersion: null,
    },
  };
}

function accountFixture(id: string, email: string, name: string): TestAccount {
  return {
    accountId: parseAccountId(id),
    email,
    name,
    sessionId: `${id}-session`,
    token: `${id}-token`,
  };
}

function operationBody(body: unknown): OperationResponseBody {
  if (
    typeof body !== "object" ||
    body === null ||
    !("operationId" in body) ||
    typeof body.operationId !== "string" ||
    !("status" in body) ||
    typeof body.status !== "string"
  ) {
    throw new Error("Response is not an Operation projection");
  }
  return body as OperationResponseBody;
}

async function jsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  return text.length === 0 ? null : (JSON.parse(text) as unknown);
}

function jsonCommandHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
}

function parseSse(body: string): Array<{
  readonly id: string;
  readonly event: string;
  readonly data: OperationEventDto;
}> {
  return body
    .replaceAll("\r", "")
    .split("\n\n")
    .map((block) => block.trim())
    .filter((block) => block.length > 0 && !block.startsWith(":"))
    .map((block) => {
      const fields = new Map(
        block.split("\n").map((line) => {
          const separator = line.indexOf(":");
          return [line.slice(0, separator), line.slice(separator + 1).trim()] as const;
        }),
      );
      return {
        id: fields.get("id") ?? "",
        event: fields.get("event") ?? "",
        data: JSON.parse(fields.get("data") ?? "null") as OperationEventDto,
      };
    });
}

function releaseBlockingCall(call: BlockingCall, text: string): void {
  if (call.released) {
    return;
  }
  call.released = true;
  call.completed.resolve(text);
}

function releaseBlockingEvaluationCall(call: BlockingEvaluationCall): void {
  if (call.released) {
    return;
  }
  call.released = true;
  call.completed.resolve(undefined);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, name: string, timeoutMs = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out during ${name}`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function settled(promise: Promise<unknown>): Promise<void> {
  await promise.then(
    () => undefined,
    () => undefined,
  );
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  name: string,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out during ${name}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
}
