import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import multer from 'multer';
import { ZodError } from 'zod';
import { ApiError, isPrismaError, zodDetails } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(ApiError.notFound(`Route introuvable : ${req.method} ${req.originalUrl}`));
}

function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (typeof error !== 'object' || error === null) return false;

  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  if (candidate.name === 'PrismaClientInitializationError') return true;
  if (candidate.code === 'P1001' || candidate.code === 'P1002' || candidate.code === 'P1017') return true;

  return (
    typeof candidate.message === 'string' &&
    candidate.message.includes("Can't reach database server")
  );
}

export function errorHandler(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ApiError) {
    if (error.status >= 500) logger.error({ err: error, path: req.originalUrl }, error.message);
    else logger.warn({ path: req.originalUrl, status: error.status }, error.message);

    res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details ?? null },
    });
    return;
  }

  if (error instanceof ZodError) {
    res.status(422).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Donnees invalides',
        details: zodDetails(error),
      },
    });
    return;
  }

  if (error instanceof multer.MulterError) {
    res.status(400).json({
      error: {
        code: 'UPLOAD_ERROR',
        message:
          error.code === 'LIMIT_FILE_SIZE'
            ? 'Fichier trop volumineux'
            : `Erreur de televersement : ${error.message}`,
        details: null,
      },
    });
    return;
  }

  if (isDatabaseUnavailable(error)) {
    logger.error(
      { err: error, path: req.originalUrl, method: req.method },
      'Base de donnees indisponible : verifiez que PostgreSQL est demarre sur localhost:5432',
    );
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message:
          'Base de donnees indisponible. Verifiez que PostgreSQL est demarre sur localhost:5432 puis reessayez.',
        details: null,
      },
    });
    return;
  }

  if (isPrismaError(error, 'P2002')) {
    const target = Array.isArray(error.meta?.target) ? (error.meta.target as string[]).join(', ') : 'valeur';
    res.status(409).json({
      error: {
        code: 'DUPLICATE',
        message: `Une entree existe deja pour : ${target}`,
        details: error.meta ?? null,
      },
    });
    return;
  }

  if (isPrismaError(error, 'P2025')) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ressource introuvable', details: null } });
    return;
  }

  logger.error({ err: error, path: req.originalUrl, method: req.method }, 'Erreur interne non geree');
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Une erreur interne est survenue',
      details: null,
    },
  });
}
