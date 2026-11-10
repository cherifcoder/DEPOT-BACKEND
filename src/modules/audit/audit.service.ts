import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { parseRange } from '../../lib/dates.js';
import { paginated, parsePagination } from '../../lib/pagination.js';

export const auditListQuerySchema = z.object({
  userId: z.uuid().optional(),
  action: z.enum(['CREATE', 'UPDATE', 'DELETE', 'EXECUTE', 'LOGIN', 'LOGOUT', 'LOGIN_FAILED']).optional(),
  entity: z.string().trim().max(60).optional(),
  search: z.string().trim().max(150).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function listAuditLogs(query: z.infer<typeof auditListQuerySchema>) {
  const pagination = parsePagination(query as Record<string, unknown>, 30, 100);
  const hasRange = Boolean(query.from || query.to || query.period);
  const range = hasRange ? parseRange(query) : null;

  const where: Prisma.AuditLogWhereInput = {
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.action ? { action: query.action } : {}),
    ...(query.entity ? { entity: { equals: query.entity, mode: 'insensitive' } } : {}),
    ...(range ? { createdAt: { gte: range.from, lte: range.to } } : {}),
    ...(query.search
      ? {
          OR: [
            { userName: { contains: query.search, mode: 'insensitive' } },
            { entity: { contains: query.search, mode: 'insensitive' } },
            { entityId: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [total, logs] = await Promise.all([
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
  ]);

  return paginated(logs, total, pagination);
}

export async function getAuditLog(id: string) {
  return prisma.auditLog.findUniqueOrThrow({ where: { id } });
}

export async function auditFilters() {
  const [users, entities] = await Promise.all([
    prisma.user.findMany({ select: { id: true, fullName: true }, orderBy: { fullName: 'asc' } }),
    prisma.auditLog.findMany({ distinct: ['entity'], select: { entity: true }, orderBy: { entity: 'asc' } }),
  ]);

  return { users, entities: entities.map((entry) => entry.entity) };
}
