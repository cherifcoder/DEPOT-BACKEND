import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { makeReference } from '../../lib/reference.js';
import { saveSignature, saveBuffer } from '../../lib/storage.js';
import { buildDeliverySlipPdf } from '../../lib/pdf.js';
import { getCompanyInfo } from '../settings/setting.service.js';
import { dayjs, parseRange, type Period } from '../../lib/dates.js';
import { dateSchema, optionalText, uuidSchema } from '../../http.js';
import { notifyUsers } from '../notifications/notification.service.js';

export const createDeliverySchema = z
  .object({
    saleId: uuidSchema.optional().nullable(),
    clientId: uuidSchema.optional().nullable(),
    productId: uuidSchema.optional().nullable(),
    quantity: z.coerce.number().int().positive().max(1_000_000).optional().nullable(),
    livreurId: uuidSchema,
    destination: z.string().trim().min(3, 'Destination requise').max(300),
    scheduledAt: dateSchema.optional().nullable(),
    notes: optionalText(1000),
    clientRef: z.string().trim().min(1).max(120).optional().nullable(),
  })
  .refine((data) => Boolean(data.saleId) || Boolean(data.productId && data.quantity), {
    message: 'Renseignez une vente ou un produit avec sa quantite',
    path: ['saleId'],
  });

export const updateDeliveryStatusSchema = z.object({
  status: z.enum(['EN_COURS', 'LIVRE', 'ANNULE']),
  receiverName: z.string().trim().max(150).optional().nullable(),
  signatureBase64: z.string().max(5_000_000).optional().nullable(),
  notes: z.string().trim().max(1000).optional().nullable(),
});

export const assignDeliverySchema = z.object({
  livreurId: uuidSchema,
});

export const deliveryListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['EN_COURS', 'LIVRE', 'ANNULE']).optional(),
  livreurId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
  saleId: uuidSchema.optional(),
  mine: z.enum(['true']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const deliveryInclude = {
  sale: {
    select: {
      id: true,
      reference: true,
      totalAmount: true,
      balanceDue: true,
      client: { select: { id: true, name: true, phone: true, address: true } },
    },
  },
  client: { select: { id: true, name: true, phone: true, address: true } },
  product: { select: { id: true, name: true, sku: true, imageUrl: true } },
  livreur: { select: { id: true, fullName: true, phone: true } },
} satisfies Prisma.DeliveryInclude;

export async function listDeliveries(query: z.infer<typeof deliveryListQuerySchema>, actorId: string) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const hasRange = Boolean(query.from || query.to || query.period);
  const range = hasRange ? parseRange(query) : null;

  const where: Prisma.DeliveryWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.livreurId ? { livreurId: query.livreurId } : {}),
    ...(query.clientId ? { clientId: query.clientId } : {}),
    ...(query.saleId ? { saleId: query.saleId } : {}),
    ...(query.mine === 'true' ? { livreurId: actorId } : {}),
    ...(range ? { createdAt: { gte: range.from, lte: range.to } } : {}),
    ...(query.search
      ? {
          OR: [
            { reference: { contains: query.search, mode: 'insensitive' } },
            { destination: { contains: query.search, mode: 'insensitive' } },
            { client: { name: { contains: query.search, mode: 'insensitive' } } },
            { sale: { reference: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };

  const [total, deliveries] = await Promise.all([
    prisma.delivery.count({ where }),
    prisma.delivery.findMany({
      where,
      include: deliveryInclude,
      orderBy: [{ status: 'asc' }, { scheduledAt: 'asc' }, { createdAt: 'desc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: deliveries,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function listLivreurs() {
  return prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: 'LIVREUR' } },
    },
    select: { id: true, fullName: true, phone: true },
    orderBy: { fullName: 'asc' },
  });
}

export async function getDelivery(id: string) {
  const delivery = await prisma.delivery.findUnique({ where: { id }, include: deliveryInclude });
  if (!delivery) throw ApiError.notFound('Livraison introuvable');
  return delivery;
}

export async function createDelivery(input: z.infer<typeof createDeliverySchema>, actorId: string) {
  if (input.clientRef) {
    const existing = await prisma.delivery.findUnique({ where: { clientRef: input.clientRef }, include: deliveryInclude });
    if (existing) return { delivery: existing, created: false };
  }

  const livreur = await prisma.user.findFirst({
    where: { id: input.livreurId, isActive: true, deletedAt: null, roles: { some: { role: 'LIVREUR' } } },
    select: { id: true, fullName: true },
  });
  if (!livreur) throw ApiError.badRequest('Livreur introuvable ou sans role LIVREUR');

  let clientId = input.clientId ?? null;
  let referenceSale: string | null = null;

  if (input.saleId) {
    const sale = await prisma.sale.findUnique({
      where: { id: input.saleId },
      select: { id: true, clientId: true, reference: true, status: true },
    });
    if (!sale) throw ApiError.badRequest('Vente introuvable');
    if (sale.status === 'ANNULEE') throw ApiError.badRequest('Impossible de livrer une vente annulee');
    clientId = sale.clientId;
    referenceSale = sale.reference;
  }

  if (input.productId) {
    const product = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null } });
    if (!product) throw ApiError.badRequest('Produit introuvable');
  }

  const delivery = await prisma.delivery.create({
    data: {
      reference: makeReference('LIV'),
      saleId: input.saleId ?? null,
      clientId,
      productId: input.productId ?? null,
      quantity: input.quantity ?? null,
      livreurId: livreur.id,
      destination: input.destination,
      status: 'EN_COURS',
      scheduledAt: input.scheduledAt ? dayjs.utc(input.scheduledAt).toDate() : null,
      notes: input.notes ?? null,
      clientRef: input.clientRef ?? null,
    },
    include: deliveryInclude,
  });

  void notifyUsers([livreur.id], {
    type: 'INFO',
    title: 'Nouvelle livraison affectee',
    body: `${delivery.reference} - ${delivery.destination}${referenceSale ? ` (vente ${referenceSale})` : ''}`,
    data: { deliveryId: delivery.id },
  }).catch(() => undefined);

  return { delivery, created: true };
}

export async function updateDeliveryStatus(
  id: string,
  input: z.infer<typeof updateDeliveryStatusSchema>,
): Promise<Prisma.DeliveryGetPayload<{ include: typeof deliveryInclude }>> {
  const delivery = await prisma.delivery.findUnique({ where: { id } });
  if (!delivery) throw ApiError.notFound('Livraison introuvable');
  if (delivery.status === 'ANNULE' && input.status !== 'ANNULE') {
    throw ApiError.conflict('Une livraison annulee ne peut pas etre reactivee');
  }

  let signatureUrl = delivery.signatureUrl;

  if (input.signatureBase64) {
    const stored = await saveSignature(input.signatureBase64);
    signatureUrl = stored.url;
  }

  if (input.status === 'LIVRE' && !signatureUrl) {
    throw ApiError.badRequest('La decharge du receptionnaire (signature) est obligatoire pour valider la livraison');
  }

  return prisma.delivery.update({
    where: { id },
    data: {
      status: input.status,
      receiverName: input.receiverName ?? delivery.receiverName,
      signatureUrl,
      deliveredAt: input.status === 'LIVRE' ? new Date() : delivery.deliveredAt,
      notes: input.notes ?? delivery.notes,
    },
    include: deliveryInclude,
  });
}

export async function assignDelivery(id: string, livreurId: string) {
  const livreur = await prisma.user.findFirst({
    where: { id: livreurId, isActive: true, deletedAt: null, roles: { some: { role: 'LIVREUR' } } },
    select: { id: true, fullName: true },
  });
  if (!livreur) throw ApiError.badRequest('Livreur introuvable ou sans role LIVREUR');

  const delivery = await prisma.delivery.update({
    where: { id },
    data: { livreurId },
    include: deliveryInclude,
  });

  void notifyUsers([livreur.id], {
    type: 'INFO',
    title: 'Livraison reassignee',
    body: `${delivery.reference} - ${delivery.destination}`,
    data: { deliveryId: delivery.id },
  }).catch(() => undefined);

  return delivery;
}

export interface DeliveryProofInput {
  signatureBase64?: string;
  signatureUrl?: string;
  photoProofUrl?: string;
  receiverName: string;
  notes?: string | null;
}

export async function completeDeliveryWithProof(
  id: string,
  input: DeliveryProofInput,
): Promise<Prisma.DeliveryGetPayload<{ include: typeof deliveryInclude }>> {
  const delivery = await prisma.delivery.findUnique({ where: { id } });
  if (!delivery) throw ApiError.notFound('Livraison introuvable');
  if (delivery.status === 'ANNULE') throw ApiError.conflict('Livraison annulee');

  let signatureUrl = input.signatureUrl ?? delivery.signatureUrl;
  if (input.signatureBase64) {
    const stored = await saveSignature(input.signatureBase64);
    signatureUrl = stored.url;
  }
  if (!signatureUrl) throw ApiError.badRequest('Signature du receptionnaire obligatoire');

  return prisma.delivery.update({
    where: { id },
    data: {
      status: 'LIVRE',
      deliveredAt: new Date(),
      receiverName: input.receiverName,
      signatureUrl,
      photoProofUrl: input.photoProofUrl ?? delivery.photoProofUrl,
      notes: input.notes ?? delivery.notes,
    },
    include: deliveryInclude,
  });
}

export async function saveDeliveryPhoto(file: { buffer: Buffer; mimetype: string }) {
  return saveBuffer(file.buffer, 'deliveries', file.mimetype);
}

export async function getDeliverySlipPdf(id: string): Promise<Buffer> {
  const delivery = await prisma.delivery.findUnique({
    where: { id },
    include: {
      sale: { include: { items: { include: { product: true } } } },
      client: true,
      product: true,
      livreur: true,
    },
  });

  if (!delivery) throw ApiError.notFound('Livraison introuvable');
  const company = await getCompanyInfo();
  return buildDeliverySlipPdf(delivery, company);
}

export async function deliveryStats(query: { from?: string; to?: string; period?: Period }) {
  const range = parseRange(query, 'month');
  const [byStatus, lateCount, count] = await Promise.all([
    prisma.delivery.groupBy({
      by: ['status'],
      where: { createdAt: { gte: range.from, lte: range.to } },
      _count: { _all: true },
    }),
    prisma.delivery.count({
      where: { status: 'EN_COURS', scheduledAt: { lt: new Date() } },
    }),
    prisma.delivery.count({ where: { createdAt: { gte: range.from, lte: range.to } } }),
  ]);

  return {
    range,
    total: count,
    lateCount,
    byStatus: byStatus.map((entry) => ({ status: entry.status, count: entry._count._all })),
  };
}
