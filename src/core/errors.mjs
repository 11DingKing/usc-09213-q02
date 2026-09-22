export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new HttpError(400, "bad_request", message, details);
export const unauthorized = (message = "缺少或无效的访问令牌") => new HttpError(401, "unauthorized", message);
export const forbidden = (message = "无权访问该资源") => new HttpError(403, "forbidden", message);
export const notFound = (message = "资源不存在") => new HttpError(404, "not_found", message);
export const conflict = (message, details) => new HttpError(409, "conflict", message, details);
