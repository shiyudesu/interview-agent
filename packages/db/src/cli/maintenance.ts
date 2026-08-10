#!/usr/bin/env node

import { createDatabaseClient } from "../client.js";
import {
  loadDatabaseEnvironment,
  readBoundedIntegerEnvironment,
  requireDatabaseUrl,
  requirePurgeAuditHashSecret,
} from "../config.js";
import { PgLifecycleRepository } from "../repositories/lifecycle-repository.js";
import { LifecycleService } from "../services/lifecycle-service.js";

function environmentValue(name: string): string | undefined {
  return process.env[name];
}

async function main(): Promise<void> {
  loadDatabaseEnvironment();
  const client = createDatabaseClient({ databaseUrl: requireDatabaseUrl() });
  try {
    const service = new LifecycleService(new PgLifecycleRepository(client.database), {
      purgeHashSecret: requirePurgeAuditHashSecret(),
      expiryBatchSize: readBoundedIntegerEnvironment("INTERVIEW_EXPIRY_BATCH_SIZE", 50, 1, 1_000),
      maximumExpiryBatchesPerCycle: readBoundedIntegerEnvironment(
        "INTERVIEW_EXPIRY_MAX_BATCHES_PER_CYCLE",
        1_000,
        1,
        100_000,
      ),
      purgeBatchSize: readBoundedIntegerEnvironment("DELETION_PURGE_BATCH_SIZE", 20, 1, 1_000),
      purgeLeaseOwner:
        environmentValue("DELETION_PURGE_LEASE_OWNER")?.trim() || `maintenance-cli-${process.pid}`,
      purgeLeaseDurationMs: readBoundedIntegerEnvironment(
        "DELETION_PURGE_LEASE_DURATION_MS",
        300_000,
        30_000,
        86_400_000,
      ),
      failedPurgeRetryDelayMs: readBoundedIntegerEnvironment(
        "DELETION_PURGE_RETRY_DELAY_MS",
        300_000,
        60_000,
        86_400_000,
      ),
      maximumPurgeRequestsPerCycle: readBoundedIntegerEnvironment(
        "DELETION_PURGE_MAX_REQUESTS_PER_CYCLE",
        1_000,
        1,
        100_000,
      ),
    });
    console.info(JSON.stringify(await service.runMaintenanceCycle()));
  } finally {
    await client.close();
  }
}

main().catch((error: unknown) => {
  console.error("Lifecycle maintenance failed.");
  if (error instanceof Error) {
    console.error(error.message);
  }
  process.exitCode = 1;
});
