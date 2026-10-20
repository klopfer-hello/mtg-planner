// One base class for the lib/ errors that carry an HTTP status: server/errors.js answers any
// StatusError with its status (and `extra`, e.g. {code: 'confirm_master'}) instead of a 500.
// The modules keep their own subclasses (BinderError, DeckError, ...) for instanceof checks.

/** An error with an HTTP status and optional extra JSON fields for the response body. */
export class StatusError extends Error {
  constructor(status, message, extra = null) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
