export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(400, "bad_request", message, details);
export const unauthorized = (message = "缺少调用方身份") => new AppError(401, "unauthorized", message);
export const forbidden = (message = "无权访问该资源") => new AppError(403, "forbidden", message);
export const notFound = (message = "资源不存在") => new AppError(404, "not_found", message);
export const conflict = (message, details) => new AppError(409, "conflict", message, details);
