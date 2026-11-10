import type { Request, Response } from 'express';
import { z, type ZodType } from 'zod';
import { ApiError } from './lib/errors.js';
import type { AuditPayload } from './lib/audit.js';
import { dayjs } from './lib/dates.js';

export const uuidSchema = z.uuid('Identifiant invalide');

export const dateSchema = z
  .string()
  .trim()
  .refine((value) => dayjs.utc(value).isValid(), 'Date invalide (format attendu : YYYY-MM-DD)');

export const optionalText = (max = 2000) => z.string().trim().max(max).optional().nullable();

export const moneySchema = z.coerce
  .number()
  .finite()
  .min(0, 'Le montant ne peut pas etre negatif')
  .max(1_000_000_000_000);

export const positiveInt = z.coerce.number().int().positive();

export const passwordSchema = z
  .string()
  .min(8, 'Le mot de passe doit contenir au moins 8 caracteres')
  .max(72, 'Le mot de passe ne peut pas depasser 72 caracteres')
  .regex(/[A-Za-z]/, 'Le mot de passe doit contenir au moins une lettre')
  .regex(/\d/, 'Le mot de passe doit contenir au moins un chiffre');

export function parseBody<T extends ZodType>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.body);
}

export function parseQuery<T extends ZodType>(schema: T, req: Request): z.infer<T> {
  return schema.parse(req.query);
}

export function idParam(req: Request, name = 'id'): string {
  return uuidSchema.parse(req.params[name]);
}

export function requireUser(req: Request) {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}

export function setAudit(res: Response, payload: AuditPayload): void {
  res.locals.audit = payload;
}

export function setAuditEntity(res: Response, entityId: string): void {
  res.locals.auditEntityId = entityId;
}

export function entityIdOf(req: Request, fallback?: string | null): string | undefined {
  if (fallback) return fallback;
  const params = req.params as Record<string, string | undefined>;
  return params.id;
}

export function parseBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}
