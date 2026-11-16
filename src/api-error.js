export class ApiError extends Error {
  constructor(message, { status = 0, body = null, code = "api_error" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

export function publicError(error) {
  if (error instanceof ApiError) {
    return { message: error.message, code: error.code, status: error.status || 500 };
  }
  return { message: error?.message || "Error inesperado", code: "internal_error", status: 500 };
}
