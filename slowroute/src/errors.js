// 统一的应用错误：code 直接对应 HTTP 层返回的机器可读错误码。
export class ApiError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code, message, details) => new ApiError(400, code, message, details);
export const unauthorized = (code = 'unauthorized', message = '需要登录') => new ApiError(401, code, message);
export const forbidden = (code = 'forbidden', message = '无权操作') => new ApiError(403, code, message);
export const notFound = (code = 'not_found', message = '资源不存在') => new ApiError(404, code, message);
export const conflict = (code, message, details) => new ApiError(409, code, message, details);
export const gone = (code, message, details) => new ApiError(410, code, message, details);
export const payloadTooLarge = (code, message, details) => new ApiError(413, code, message, details);
export const unprocessable = (code, message, details) => new ApiError(422, code, message, details);
