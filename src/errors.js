// Errors carry the process exit code and a stable machine code. Messages are
// shown to the author as is, so they are written in French.

export const EXIT = Object.freeze({ OK: 0, FAILED: 1, USAGE: 2, AUTH: 3 });

export class CliError extends Error {
  constructor(message, { exitCode = EXIT.FAILED, code = 'FAILED', details, hint } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.code = code;
    this.details = details;
    this.hint = hint;
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function usageError(message, options = {}) {
  return new CliError(message, { exitCode: EXIT.USAGE, code: 'USAGE', ...options });
}

export function authError(message, options = {}) {
  return new CliError(message, { exitCode: EXIT.AUTH, code: 'AUTH_REQUIRED', ...options });
}
