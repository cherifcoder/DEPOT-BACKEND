import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, message: string, code = 'API_ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, message, 'BAD_REQUEST', details);
  }

  static unauthorized(message = 'Authentification requise') {
    return new ApiError(401, message, 'UNAUTHORIZED');
  }

  static forbidden(message = 'Acces refuse') {
    return new ApiError(403, message, 'FORBIDDEN');
  }

  static notFound(message = 'Ressource introuvable') {
    return new ApiError(404, message, 'NOT_FOUND');
  }

  static conflict(message: string, details?: unknown) {
    return new ApiError(409, message, 'CONFLICT', details);
  }

  static unprocessable(message: string, details?: unknown) {
    return new ApiError(422, message, 'VALIDATION_ERROR', details);
  }

  static tooManyRequests(message = 'Trop de tentatives, reessayez plus tard') {
    return new ApiError(429, message, 'TOO_MANY_REQUESTS');
  }
}

export function isPrismaError(error: unknown, code?: string): error is Prisma.PrismaClientKnownRequestError {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return code ? error.code === code : true;
}

export function isUniqueConstraintError(error: unknown) {
  return isPrismaError(error, 'P2002');
}

export function isNotFoundError(error: unknown) {
  return isPrismaError(error, 'P2025');
}

export function isWriteConflict(error: unknown) {
  return isPrismaError(error, 'P2034');
}

export function zodDetails(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}
