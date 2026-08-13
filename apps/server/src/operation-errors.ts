export class OperationRunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationRunnerError";
  }
}
