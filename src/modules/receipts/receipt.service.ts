import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseRange, dayjs, type Period } from '../../lib/dates.js';
import { dateSchema, moneySchema, uuidSchema } from '../../http.js';

export const manualReceiptSchema = z.object({
  label: z.string().trim().min(3, 'Libelle requis').max(200),
  amount: moneySchema.refine((value) => value > 0, 'Le montant doit etre superieur a zero'),
  receiptDate: dateSchema.optional(),
  notes: z.string().trim().max(1000).optional().nullable(),
  clientRef: z.string().trim().min(1).max(120).optional().nullable(),
});

export const receiptListQuerySchema = z.object({
  source: z.enum(['VENTE', 'MANUEL', 'AUTRE']).optional(),
  search: z.string().trim().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const receiptInclude = {
  receivedBy: { select: { id: true, fullName: true } },
  sale: { select: { id: true, reference: true, client: { select: { id: true, name: true } } } },
} satisfies Prisma.ReceiptInclude;

export async function listReceipts(query: z.infer<typeof receiptListQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const hasRange = Boolean(query.from || query.to || query.period);
  const range = hasRange ? parseRange(query) : null;

  const where: Prisma.ReceiptWhereInput = {
    ...(query.source ? { source: query.source } : {}),
    ...(range ? { receiptDate: { gte: range.from, lte: range.to } } : {}),
    ...(query.search
      ? {
          OR: [
            { label: { contains: query.search, mode: 'insensitive' } },
            { sale: { reference: { contains: query.search, mode: 'insensitive' } } },
            { sale: { client: { name: { contains: query.search, mode: 'insensitive' } } } },
          ],
        }
      : {}),
  };

  const [total, receipts] = await Promise.all([
    prisma.receipt.count({ where }),
    prisma.receipt.findMany({
      where,
      include: receiptInclude,
      orderBy: { receiptDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: receipts,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function createManualReceipt(input: z.infer<typeof manualReceiptSchema>, actorId: string) {
  if (input.clientRef) {
    const existing = await prisma.receipt.findUnique({ where: { clientRef: input.clientRef }, include: receiptInclude });
    if (existing) return { receipt: existing, created: false };
  }

  const receipt = await prisma.receipt.create({
    data: {
      label: input.label,
      amount: input.amount,
      source: 'MANUEL',
      receivedById: actorId,
      receiptDate: input.receiptDate ? dayjs.utc(input.receiptDate).toDate() : new Date(),
      notes: input.notes ?? null,
      clientRef: input.clientRef ?? null,
    },
    include: receiptInclude,
  });

  return { receipt, created: true };
}

export async function deleteManualReceipt(id: string) {
  const receipt = await prisma.receipt.findUnique({ where: { id }, include: receiptInclude });
  if (!receipt) throw ApiError.notFound('Recette introuvable');
  if (receipt.source === 'VENTE') {
    throw ApiError.conflict('Une recette issue d une vente ne peut pas etre supprimee directement');
  }
  await prisma.receipt.delete({ where: { id } });
  return receipt;
}

export async function receiptSummary(query: { from?: string; to?: string; period?: Period }) {
  const range = parseRange(query, 'month');
  const where: Prisma.ReceiptWhereInput = {
    receiptDate: { gte: range.from, lte: range.to },
    OR: [{ source: { not: 'VENTE' } }, { sale: { status: { not: 'ANNULEE' } } }],
  };

  const [totals, bySource] = await Promise.all([
    prisma.receipt.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
    prisma.receipt.groupBy({ by: ['source'], where, _sum: { amount: true }, _count: { _all: true } }),
  ]);

  return {
    range,
    totalAmount: totals._sum.amount ?? 0,
    count: totals._count._all,
    bySource: bySource.map((entry) => ({
      source: entry.source,
      amount: entry._sum.amount ?? 0,
      count: entry._count._all,
    })),
  };
}

export const receiptIdSchema = uuidSchema;
