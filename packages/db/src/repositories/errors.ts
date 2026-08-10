export class RepositoryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RepositoryError";
  }
}

export class RepositoryNotFoundError extends RepositoryError {
  constructor(
    readonly resource: string,
    readonly identifier: string,
  ) {
    super("repository_not_found", `${resource} ${identifier} was not found`);
    this.name = "RepositoryNotFoundError";
  }
}

export class RepositoryVersionConflictError extends RepositoryError {
  constructor(
    readonly interviewId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(
      "repository_version_conflict",
      `Interview ${interviewId} expected version ${expectedVersion}, current version is ${actualVersion}`,
    );
    this.name = "RepositoryVersionConflictError";
  }
}

export class RepositoryInterviewExpiredError extends RepositoryError {
  constructor(
    readonly interviewId: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
    readonly expiredAt: Date,
  ) {
    super(
      "repository_interview_expired",
      `Interview ${interviewId} expired at version ${actualVersion}`,
    );
    this.name = "RepositoryInterviewExpiredError";
  }
}

export class RepositoryImmutableConflictError extends RepositoryError {
  constructor(
    readonly resource: string,
    readonly identifier: string,
    options?: ErrorOptions,
  ) {
    super(
      "repository_immutable_conflict",
      `${resource} ${identifier} already exists or is immutable`,
      options,
    );
    this.name = "RepositoryImmutableConflictError";
  }
}

export class RepositoryIdempotencyConflictError extends RepositoryError {
  constructor(
    readonly scope: string,
    readonly idempotencyKey: string,
  ) {
    super(
      "repository_idempotency_conflict",
      `Idempotency key ${idempotencyKey} conflicts with the existing Operation in scope ${scope}`,
    );
    this.name = "RepositoryIdempotencyConflictError";
  }
}

export class RepositoryOperationLeaseConflictError extends RepositoryError {
  constructor(readonly operationId: string) {
    super(
      "repository_operation_lease_conflict",
      `Operation ${operationId} is not claimable by this lease`,
    );
    this.name = "RepositoryOperationLeaseConflictError";
  }
}

export class RepositoryOperationRetryConflictError extends RepositoryError {
  constructor(readonly operationId: string) {
    super(
      "repository_operation_retry_conflict",
      `Operation ${operationId} is not eligible for the requested retry`,
    );
    this.name = "RepositoryOperationRetryConflictError";
  }
}

export class RepositoryInterviewUnavailableError extends RepositoryError {
  constructor(
    readonly interviewId: string,
    readonly status: string,
    readonly version: number,
  ) {
    super(
      "repository_interview_unavailable",
      `Interview ${interviewId} is ${status} at version ${version}`,
    );
    this.name = "RepositoryInterviewUnavailableError";
  }
}

export class RepositoryUnsafePayloadError extends RepositoryError {
  constructor(readonly field: string) {
    super("repository_unsafe_payload", `Operation ${field} must be a safe JSON object`);
    this.name = "RepositoryUnsafePayloadError";
  }
}

export class RepositoryCorruptionError extends RepositoryError {
  constructor(
    readonly resource: string,
    readonly identifier: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(
      "repository_corruption",
      `Persisted ${resource} ${identifier} is corrupt: ${detail}`,
      options,
    );
    this.name = "RepositoryCorruptionError";
  }
}
