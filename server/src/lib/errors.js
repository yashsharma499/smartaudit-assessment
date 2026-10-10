export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class AIProviderError extends Error {
  constructor(message, { retryable = true, status } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}
