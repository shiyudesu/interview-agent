import { createDatabaseClient, PgLifecycleRepository } from "@interview-agent/db";
import Fastify from "fastify";

import { registerApplication } from "./app.js";
import { createAuthentication } from "./auth.js";
import { loadServerConfig } from "./config.js";
import { DeletionOrchestrationService } from "./deletion.js";
import { createNodemailerEmailSender } from "./email-sender.js";
import { createModelRuntime, type ModelRuntime } from "./model-runtime.js";
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

await registerApplication(app, { authentication, config, deletion });
app.addHook("onClose", async () => databaseClient.close());
installGracefulShutdown(app);
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  throw error;
}
