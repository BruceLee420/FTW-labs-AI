/**
 * Minimal structured logger. Never pass résumé text or prompt bodies to it;
 * log ids, counts and error names instead.
 */
export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function createLogger(prefix = "radar", sink: Pick<Console, "log" | "warn" | "error"> = console): Logger {
  const fmt = (level: string, message: string, fields?: Record<string, unknown>) =>
    `[${prefix}] ${level} ${message}${fields && Object.keys(fields).length ? " " + JSON.stringify(fields) : ""}`;
  return {
    info: (m, f) => sink.log(fmt("info", m, f)),
    warn: (m, f) => sink.warn(fmt("warn", m, f)),
    error: (m, f) => sink.error(fmt("error", m, f)),
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
