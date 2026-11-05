/** Minimal structured logger. Never pass secrets in `fields`. */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Logs one JSON object per line: info to stdout, warnings and errors to stderr. */
export const consoleLogger: Logger = {
  info: (message, fields) => {
    process.stdout.write(`${JSON.stringify({ level: 'info', message, ...fields })}\n`);
  },
  warn: (message, fields) => {
    process.stderr.write(`${JSON.stringify({ level: 'warn', message, ...fields })}\n`);
  },
  error: (message, fields) => {
    process.stderr.write(`${JSON.stringify({ level: 'error', message, ...fields })}\n`);
  },
};

/** A logger that discards everything. */
export const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
