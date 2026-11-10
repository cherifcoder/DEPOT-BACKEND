import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { moneySchema } from '../../http.js';
import { buildClientStatementPdf } from '../../lib/pdf.js';
import { getCompanyInfo } from '../settings/setting.service.js';
import { parseRange, type Period } from '../../lib/dates.js';

export const clientSchema = z.object({
  name: z.string().trim().min(2, 'Nom requis').max(150),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.email('Email invalide').optional().nullable().or(z.literal('')),
  address: z.string().trim().max(300).optional().nullable(),
  creditLimit: moneySchema.optional().default(0),
  notes: z.string().trim().max(2000).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const clientListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  withDebt: z.enum(['true']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

async function outstandingByClientIds(ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();

  const grouped = await prisma.sale.groupBy({
    by: ['clientId'],
    where: { clientId: { in: ids }, status: { not: 'ANNULEE' } },
    _sum: { balanceDue: true },
  });

  return new Map(
    grouped
      .filter((entry): entry is typeof entry & { clientId: string } => Boolean(entry.clientId))
      .map((entry) => [entry.clientId, Number(entry._sum.balanceDue ?? 0)]),
  );
}

export async function listClients(query: z.infer<typeof clientListQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const where = {
    deletedAt: null,
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { phone: { contains: query.search, mode: 'insensitive' as const } },
            { email: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
    ...(query.withDebt === 'true'
      ? { sales: { some: { balanceDue: { gt: 0 }, status: { not: 'ANNULEE' as const } } } }
      : {}),
  };

  const [total, clients] = await Promise.all([
    prisma.client.count({ where }),
    prisma.client.findMany({
      where,
      include: {
        _count: { select: { sales: true } },
        sales: { orderBy: { saleDate: 'desc' }, take: 1, select: { saleDate: true, balanceDue: true } },
      },
      orderBy: { name: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const balances = await outstandingByClientIds(clients.map((client) => client.id));

  return {
    data: clients.map((client) => ({
      ...client,
      outstanding: balances.get(client.id) ?? 0,
      lastSaleAt: client.sales[0]?.saleDate ?? null,
      sales: undefined,
    })),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getClient(id: string) {
  const client = await prisma.client.findFirst({
    where: { id, deletedAt: null },
    include: {
      sales: {
        orderBy: { saleDate: 'desc' },
        take: 100,
        include: {
          user: { select: { id: true, fullName: true } },
          items: { include: { product: { select: { id: true, name: true, sku: true } } } },
          deliveries: { select: { id: true, reference: true, status: true } },
        },
      },
      payments: {
        orderBy: { paidAt: 'desc' },
        take: 100,
        include: { receivedBy: { select: { id: true, fullName: true } } },
      },
      _count: { select: { sales: true, payments: true, deliveries: true } },
    },
  });

  if (!client) throw ApiError.notFound('Client introuvable');

  const totals = await prisma.sale.aggregate({
    where: { clientId: id, status: { not: 'ANNULEE' } },
    _sum: { totalAmount: true, paidAmount: true, balanceDue: true },
    _count: { _all: true },
  });

  const overdue = await prisma.sale.aggregate({
    where: {
      clientId: id,
      status: { not: 'ANNULEE' },
      balanceDue: { gt: 0 },
      dueDate: { lt: new Date() },
    },
    _sum: { balanceDue: true },
  });

  return {
    ...client,
    totals: {
      salesCount: totals._count._all,
      totalAmount: totals._sum.totalAmount ?? 0,
      totalPaid: totals._sum.paidAmount ?? 0,
      outstanding: totals._sum.balanceDue ?? 0,
      overdue: overdue._sum.balanceDue ?? 0,
    },
  };
}

export async function createClient(input: z.infer<typeof clientSchema>) {
  return prisma.client.create({ data: { ...input, email: input.email || null } });
}

export async function updateClient(id: string, input: Partial<z.infer<typeof clientSchema>>) {
  await prisma.client.findFirstOrThrow({ where: { id, deletedAt: null } });
  return prisma.client.update({
    where: { id },
    data: { ...input, email: input.email !== undefined ? input.email || null : undefined },
  });
}

export async function archiveClient(id: string): Promise<void> {
  const client = await prisma.client.findFirst({ where: { id, deletedAt: null } });
  if (!client) throw ApiError.notFound('Client introuvable');

  const outstanding = await prisma.sale.aggregate({
    where: { clientId: id, status: { not: 'ANNULEE' } },
    _sum: { balanceDue: true },
  });

  if (Number(outstanding._sum.balanceDue ?? 0) > 0) {
    throw ApiError.conflict('Impossible d archiv er un client ayant un solde impaye');
  }

  await prisma.client.update({ where: { id }, data: { isActive: false, deletedAt: new Date() } });
}

export async function topClients(from: Date, to: Date, limit = 10) {
  const grouped = await prisma.sale.groupBy({
    by: ['clientId'],
    where: {
      clientId: { not: null },
      status: { not: 'ANNULEE' },
      saleDate: { gte: from, lte: to },
    },
    _sum: { totalAmount: true, balanceDue: true },
    _count: { _all: true },
    orderBy: { _sum: { totalAmount: 'desc' } },
    take: limit,
  });

  const clients = await prisma.client.findMany({
    where: { id: { in: grouped.map((entry) => entry.clientId).filter((value): value is string => Boolean(value)) } },
    select: { id: true, name: true, phone: true },
  });
  const byId = new Map(clients.map((client) => [client.id, client]));

  return grouped.map((entry) => ({
    client: byId.get(entry.clientId ?? '') ?? { id: entry.clientId, name: 'Client supprime', phone: null },
    totalAmount: entry._sum.totalAmount ?? 0,
    outstanding: entry._sum.balanceDue ?? 0,
    salesCount: entry._count._all,
  }));
}

export async function getClientStatement(id: string, query: { from?: string; to?: string; period?: Period }) {
  const client = await prisma.client.findFirst({
    where: { id, deletedAt: null },
    include: { sales: { include: { payments: true }, orderBy: { saleDate: 'desc' } } },
  });

  if (!client) throw ApiError.notFound('Client introuvable');

  const range = parseRange(query, 'year');
  const filtered = {
    ...client,
    sales: client.sales.filter((sale) => sale.saleDate >= range.from && sale.saleDate <= range.to),
  };

  const company = await getCompanyInfo();
  return buildClientStatementPdf(filtered, company, range);
}
