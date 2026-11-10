import type { NextFunction, Request, Response } from 'express';
import { recordAudit, type AuditPayload } from '../lib/audit.js';
import { logger } from '../lib/logger.js';

declare global {
  namespace Express {
    interface Locals {
      audit?: AuditPayload;
      skipAudit?: boolean;
      auditEntityId?: string | null;
    }
  }
}

const ACTION_BY_METHOD: Record<string, AuditPayload['action']> = {
  POST: 'CREATE',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
};

function entityFromPath(req: Request): string {
  const segments = req.path.split('/').filter(Boolean);
  return segments[0] ?? 'unknown';
}

/**
 * Journalise automatiquement toute mutation reussie.
 * Un handler peut enrichir/trahir le log via res.locals.audit.
 */
export function auditMutations(req: Request, res: Response, next: NextFunction): void {
  const action = ACTION_BY_METHOD[req.method];
  if (!action) {
    next();
    return;
  }

  res.on('finish', () => {
    if (res.statusCode >= 400 || res.locals.skipAudit) return;

    const explicit = res.locals.audit;
    const payload: AuditPayload = explicit ?? {
      action,
      entity: entityFromPath(req),
      entityId: res.locals.auditEntityId ?? (typeof req.params.id === 'string' ? req.params.id : null),
      after: req.body as unknown,
    };

    recordAudit(req, payload).catch((error) => {
      logger.error({ err: error, path: req.originalUrl }, 'Echec de journalisation d audit');
    });
  });

  next();
}
