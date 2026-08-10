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
