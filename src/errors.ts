export const ExitCode = {
  OK: 0,
  VALIDATION: 2,
  POLICY_DENIED: 3,
  PATH_DENIED: 4,
  TEST_FAILED: 5,
  INTERNAL: 6
} as const;

export class StinkyCobblerError extends Error {
  constructor(
    public readonly code: string,
    public readonly exitCode: number,
    message: string,
    public readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = "StinkyCobblerError";
  }
}
