export class WorkflowError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "WorkflowError"
  }
}

export class CommandError extends WorkflowError {
  constructor(
    readonly command: readonly string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    message = `Command failed: ${command.join(" ")}`,
  ) {
    super(message)
    this.name = "CommandError"
  }
}
