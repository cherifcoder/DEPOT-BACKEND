import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { uuidSchema } from '../../http.js';

export const supplierSchema = z.object({
  name: z.string().trim().min(2, 'Nom requis').max(150),
  contactName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(30).optional().nullable(),
  email: z.email('Email invalide').optional().nullable().or(z.literal('')),
  address: z.string().trim().max(300).optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
  isActive: z.boolean().optional(),
});

export const supplierListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function listSuppliers(query: z.infer<typeof supplierListQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const where = {
    deletedAt: null,
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { phone: { contains: query.search, mode: 'insensitive' as const } },
            { contactName: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
  };

  const [total, suppliers] = await Promise.all([
    prisma.supplier.count({ where }),
    prisma.supplier.findMany({
      where,
      include: {
        _count: { select: { purchases: true } },
        purchases: { select: { totalAmount: true, purchaseDate: true }, orderBy: { purchaseDate: 'desc' }, take: 1 },
      },
      orderBy: { name: 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  const totals = await prisma.purchase.groupBy({
    by: ['supplierId'],
    _sum: { totalAmount: true },
    where: { supplierId: { in: suppliers.map((supplier) => supplier.id) } },
  });
  const totalsById = new Map(totals.map((entry) => [entry.supplierId, entry._sum.totalAmount ?? 0]));

  return {
    data: suppliers.map((supplier) => ({
      ...supplier,
      totalPurchases: totalsById.get(supplier.id) ?? 0,
      lastPurchaseAt: supplier.purchases[0]?.purchaseDate ?? null,
      purchases: undefined,
    })),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getSupplier(id: string) {
  const supplier = await prisma.supplier.findFirst({
    where: { id, deletedAt: null },
    include: {
      purchases: {
        orderBy: { purchaseDate: 'desc' },
        take: 50,
        include: {
          user: { select: { id: true, fullName: true } },
          items: { include: { product: { select: { id: true, name: true, sku: true } } } },
        },
      },
      _count: { select: { purchases: true } },
    },
  });

  if (!supplier) throw ApiError.notFound('Fournisseur introuvable');

  const totals = await prisma.purchase.aggregate({
    where: { supplierId: id },
    _sum: { totalAmount: true, transportFees: true },
  });

  return { ...supplier, totals: totals._sum };
}

export async function createSupplier(input: z.infer<typeof supplierSchema>) {
  return prisma.supplier.create({ data: { ...input, email: input.email || null } });
}

export async function updateSupplier(id: string, input: Partial<z.infer<typeof supplierSchema>>) {
  await prisma.supplier.findFirstOrThrow({ where: { id, deletedAt: null } });
  return prisma.supplier.update({
    where: { id },
    data: { ...input, email: input.email !== undefined ? input.email || null : undefined },
  });
}

export async function archiveSupplier(id: string): Promise<void> {
  await prisma.supplier.update({ where: { id }, data: { isActive: false, deletedAt: new Date() } });
}

export async function topSuppliers(from: Date, to: Date, limit = 10) {
  const grouped = await prisma.purchase.groupBy({
    by: ['supplierId'],
    where: { purchaseDate: { gte: from, lte: to } },
    _sum: { totalAmount: true },
    _count: { _all: true },
    orderBy: { _sum: { totalAmount: 'desc' } },
    take: limit,
  });

  const suppliers = await prisma.supplier.findMany({
    where: { id: { in: grouped.map((entry) => entry.supplierId) } },
    select: { id: true, name: true, phone: true },
  });
  const byId = new Map(suppliers.map((supplier) => [supplier.id, supplier]));

  return grouped.map((entry) => ({
    supplier: byId.get(entry.supplierId) ?? { id: entry.supplierId, name: 'Fournisseur supprime', phone: null },
    totalAmount: entry._sum.totalAmount ?? 0,
    purchaseCount: entry._count._all,
  }));
}

export const supplierIdSchema = uuidSchema;
