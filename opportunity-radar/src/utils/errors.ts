/**
 * Errors that map to HTTP responses. The `message` is safe to send to the
 * browser; anything sensitive goes in `detail`, which is logged only.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  constructor(status: number, message: string, code = "error", detail?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export const badRequest = (message: string, detail?: unknown) => new HttpError(400, message, "bad_request", detail);
export const unauthorized = (message = "Not authorised.") => new HttpError(401, message, "unauthorized");
export const forbidden = (message = "Forbidden.") => new HttpError(403, message, "forbidden");
export const notFound = (message = "Not found.") => new HttpError(404, message, "not_found");
export const conflict = (message: string, detail?: unknown) => new HttpError(409, message, "conflict", detail);
export const unprocessable = (message: string, detail?: unknown) =>
  new HttpError(422, message, "unprocessable", detail);
export const tooManyRequests = (message = "Slow down a moment, then try again.") =>
  new HttpError(429, message, "rate_limited");
export const serviceUnavailable = (message: string, detail?: unknown) =>
  new HttpError(503, message, "unavailable", detail);
