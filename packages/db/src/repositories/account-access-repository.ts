import { type AccountId, parseAccountId } from "@interview-agent/domain";
import { and, asc, eq, gt, isNull, notExists, sql } from "drizzle-orm";

import type { Database } from "../client.js";
import { account, deletionRequests, session, user } from "../schema/index.js";
import { RepositoryCorruptionError } from "./errors.js";
import { RepositoryExecution } from "./transaction.js";

export interface AccountProfile {
  readonly accountId: AccountId;
  readonly name: string | null;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly image: string | null;
  readonly createdAt: Date;
}

export type LinkedIdentity =
  | {
      readonly providerId: "email-otp";
      readonly providerAccountId: string;
      readonly linkedAt: Date;
    }
  | {
      readonly providerId: "github";
      readonly providerAccountId: string;
      readonly linkedAt: Date;
    };

export interface AccountSessionProjection {
  readonly sessionId: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly current: boolean;
}

export interface AccountAccessProjection {
  readonly profile: AccountProfile;
  readonly linkedIdentities: readonly LinkedIdentity[];
  readonly sessions: readonly AccountSessionProjection[];
}

export class PgAccountAccessRepository {
  private readonly execution: RepositoryExecution;

  constructor(
    database: Database,
    execution: RepositoryExecution = new RepositoryExecution(database),
  ) {
    this.execution = execution;
  }

  findAccountAccess(
    accountId: AccountId,
    currentSessionId?: string,
  ): Promise<AccountAccessProjection | null> {
    return this.execution.inTransaction(
      async (executor) => {
        const [profileRow] = await executor
          .select({
            id: user.id,
            name: user.name,
            email: user.email,
            emailVerified: user.emailVerified,
            image: user.image,
            createdAt: user.createdAt,
          })
          .from(user)
          .where(
            and(
              eq(user.id, accountId),
              isNull(user.deletionRequestedAt),
              notExists(
                executor
                  .select({ id: deletionRequests.id })
                  .from(deletionRequests)
                  .where(
                    and(
                      eq(deletionRequests.scope, "account"),
                      eq(deletionRequests.ownerUserId, accountId),
                    ),
                  ),
              ),
            ),
          )
          .limit(1);
        if (profileRow === undefined) {
          return null;
        }

        const accountRows = await executor
          .select({
            providerAccountId: account.accountId,
            linkedAt: account.createdAt,
          })
          .from(account)
          .where(and(eq(account.userId, accountId), eq(account.providerId, "github")))
          .orderBy(asc(account.createdAt), asc(account.id));
        const sessionRows = await executor
          .select({
            sessionId: session.id,
            expiresAt: session.expiresAt,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            ipAddress: session.ipAddress,
            userAgent: session.userAgent,
          })
          .from(session)
          .where(
            and(
              eq(session.userId, accountId),
              gt(session.expiresAt, sql<Date>`timezone('UTC', statement_timestamp())`),
            ),
          )
          .orderBy(asc(session.createdAt), asc(session.id));

        return {
          profile: {
            accountId: decodeAccountId(profileRow.id),
            name: profileRow.name.trim() || null,
            email: requireText(profileRow.email, profileRow.id, "email"),
            emailVerified: profileRow.emailVerified,
            image: profileRow.image,
            createdAt: cloneDate(profileRow.createdAt, profileRow.id, "createdAt"),
          },
          linkedIdentities: [
            {
              providerId: "email-otp",
              providerAccountId: profileRow.email,
              linkedAt: cloneDate(profileRow.createdAt, profileRow.id, "createdAt"),
            },
            ...accountRows.map((row) => ({
              providerId: "github" as const,
              providerAccountId: requireText(
                row.providerAccountId,
                profileRow.id,
                "providerAccountId",
              ),
              linkedAt: cloneDate(row.linkedAt, profileRow.id, "linkedAt"),
            })),
          ],
          sessions: sessionRows.map((row) => ({
            sessionId: requireText(row.sessionId, profileRow.id, "sessionId"),
            expiresAt: cloneDate(row.expiresAt, profileRow.id, "expiresAt"),
            createdAt: cloneDate(row.createdAt, profileRow.id, "createdAt"),
            updatedAt: cloneDate(row.updatedAt, profileRow.id, "updatedAt"),
            ipAddress: row.ipAddress,
            userAgent: row.userAgent,
            current: currentSessionId !== undefined && row.sessionId === currentSessionId,
          })),
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  isSessionActive(accountId: AccountId, sessionId: string): Promise<boolean> {
    return this.execution.inTransaction(
      async (executor) => {
        const rows = await executor
          .select({ id: session.id })
          .from(session)
          .innerJoin(user, eq(user.id, session.userId))
          .where(
            and(
              eq(session.id, sessionId),
              eq(session.userId, accountId),
              gt(session.expiresAt, sql<Date>`timezone('UTC', statement_timestamp())`),
              isNull(user.deletionRequestedAt),
              notExists(
                executor
                  .select({ id: deletionRequests.id })
                  .from(deletionRequests)
                  .where(
                    and(
                      eq(deletionRequests.scope, "account"),
                      eq(deletionRequests.ownerUserId, accountId),
                    ),
                  ),
              ),
            ),
          )
          .limit(1);
        return rows.length !== 0;
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}

function decodeAccountId(value: string): AccountId {
  try {
    return parseAccountId(value);
  } catch (error) {
    throw new RepositoryCorruptionError("account", value, "account ID is invalid", {
      cause: error,
    });
  }
}

function requireText(value: string, accountId: string, field: string): string {
  if (value.trim().length === 0) {
    throw new RepositoryCorruptionError("account", accountId, `${field} is blank`);
  }
  return value;
}

function cloneDate(value: Date, accountId: string, field: string): Date {
  if (Number.isNaN(value.valueOf())) {
    throw new RepositoryCorruptionError("account", accountId, `${field} is invalid`);
  }
  return new Date(value);
}
