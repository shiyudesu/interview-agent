import { createDatabaseClient } from "@interview-agent/db";
import Fastify from "fastify";

import { registerApplication } from "./app.js";
import { createAuthentication } from "./auth.js";
import { loadServerConfig } from "./config.js";
import { createNodemailerEmailSender } from "./email-sender.js";
import { installGracefulShutdown } from "./shutdown.js";

const config = loadServerConfig();
const databaseClient = createDatabaseClient({ databaseUrl: config.databaseUrl });
const app = Fastify({ logger: { level: config.logLevel } });
const emailSender = createNodemailerEmailSender(config.email, app.log);
const authentication = createAuthentication({
  database: databaseClient.database,
  config,
  emailSender,
});

await registerApplication(app, { authentication, config });
app.addHook("onClose", async () => databaseClient.close());
installGracefulShutdown(app);
try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await app.close();
  throw error;
}
