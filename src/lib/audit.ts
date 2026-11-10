import type { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { prisma } from './prisma.js';

export interface AuditPayload {
  action: 'CREATE' | 'UPDATE' | 'DELETE' | 'EXECUTE';
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = /password|token|secret|signaturebase64|authorization/i;
const MAX_STRING_LENGTH = 1500;
const MAX_DEPTH = 6;

/** Nettoie un payload avant journalisation : secrets masques, chaines tronquees. */
export function sanitizeAuditPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[profondeur maximale]';

  if (typeof value === 'string') {
    if (value.startsWith('data:')) return '[media base64 tronque]';
    if (value.length > MAX_STRING_LENGTH) {
      return `${value.slice(0, MAX_STRING_LENGTH)}… [tronque]`;
    }
    return value;
  }

  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeAuditPayload(item, depth + 1));

  if (typeof value === 'object') {
    if ('toJSON' in value && typeof (value as { toJSON: unknown }).toJSON === 'function') {
      return sanitizeAuditPayload((value as { toJSON: () => unknown }).toJSON(), depth + 1);
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_KEYS.test(key))
        .map(([key, entry]) => [key, sanitizeAuditPayload(entry, depth + 1)]),
    );
  }

  return value;
}

export async function recordAudit(
  req: Request,
  payload: AuditPayload,
  fallbackUserName?: string,
): Promise<void> {
  const user = req.user;

  await prisma.auditLog.create({
    data: {
      userId: user?.id ?? null,
      userName: user?.fullName ?? fallbackUserName ?? 'Systeme',
      action: payload.action,
      entity: payload.entity,
      entityId: payload.entityId ?? null,
      before: (sanitizeAuditPayload(payload.before) ?? null) as Prisma.InputJsonValue,
      after: (sanitizeAuditPayload(payload.after) ?? null) as Prisma.InputJsonValue,
      metadata: (sanitizeAuditPayload(payload.metadata) ?? null) as Prisma.InputJsonValue,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? null,
    },
  });
}

export async function recordAuthAudit(
  req: Request,
  input: {
    action: 'LOGIN' | 'LOGOUT' | 'LOGIN_FAILED';
    userId?: string | null;
    userName: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId: input.userId ?? null,
      userName: input.userName,
      action: input.action,
      entity: 'auth',
      metadata: (sanitizeAuditPayload(input.metadata) ?? null) as Prisma.InputJsonValue,
      ipAddress: req.ip,
      userAgent: req.get('user-agent') ?? null,
    },
  });
}
