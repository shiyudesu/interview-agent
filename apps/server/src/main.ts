import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  PgLifecycleRepository,
  PgRepositoryUnitOfWork,
} from "@interview-agent/db";
import Fastify from "fastify";

import { PiAnswerEvaluationModel } from "./answer-evaluation-model.js";
import { registerApplication } from "./app.js";
import { createAuthentication } from "./auth.js";
import { createInterviewCommandRouteDependencies } from "./command-routes.js";
import { loadServerConfig } from "./config.js";
import { DeletionOrchestrationService } from "./deletion.js";
import { createNodemailerEmailSender } from "./email-sender.js";
import { PiAgentInterviewerTextModel } from "./interviewer-text-model.js";
import { createModelRuntime, type ModelRuntime } from "./model-runtime.js";
import { createOperationEventRouteDependencies, OperationEventBroker } from "./operation-events.js";
import {
  InterviewOperationHandlers,
  OperationRunner,
  ServerOwnedOperationStarter,
} from "./operation-runner.js";
import { createCanonicalReadRouteDependencies } from "./read-routes.js";
import { PiReportAnalysisModel } from "./report-analysis-model.js";
import { installGracefulShutdown } from "./shutdown.js";

const config = loadServerConfig();
const modelRuntime = await createModelRuntime(config.model);
const databaseClient = createDatabaseClient({ databaseUrl: config.databaseUrl });
const app = Fastify({ logger: { level: config.logLevel } });
app.decorate<ModelRuntime>("modelRuntime", modelRuntime);
const emailSender = createNodemailerEmailSender(config.email, app.log);
const authentication = createAuthentication({
  database: databaseClient.database,
  config,
  emailSender,
});
const deletion = new DeletionOrchestrationService(
  new PgLifecycleRepository(databaseClient.database),
);
const unitOfWork = new PgRepositoryUnitOfWork(databaseClient.database);
const operationEventBroker = new OperationEventBroker();
const interviewOperations = new InterviewOperationHandlers(
  new OperationRunner(
    unitOfWork,
    new PiAgentInterviewerTextModel(modelRuntime),
    new PiAnswerEvaluationModel(modelRuntime),
    new PiReportAnalysisModel(modelRuntime),
    {
      leaseOwner: `server-${randomUUID()}`,
      events: operationEventBroker,
    },
  ),
);
const interviewCommands = createInterviewCommandRouteDependencies(
  interviewOperations,
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
  new ServerOwnedOperationStarter((operationId) => {
    app.log.error(
      { event: "operation_execution_failed", operationId },
      "Server-owned Operation execution failed",
    );
  }),
);
const canonicalReads = createCanonicalReadRouteDependencies(unitOfWork);
const operationEvents = createOperationEventRouteDependencies(unitOfWork, operationEventBroker);

await registerApplication(app, {
  authentication,
  config,
  deletion,
  interviewCommands,
  canonicalReads,
  operationEvents,
});
app.addHook("onClose", async () => databaseClient.close());
installGracefulShutdown(app);
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  throw error;
}
