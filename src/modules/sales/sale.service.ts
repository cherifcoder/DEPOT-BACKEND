import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError, isUniqueConstraintError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { applyStockChange } from '../../lib/stock.js';
import { serializableTransaction, type Tx } from '../../lib/transaction.js';
import { makeReference } from '../../lib/reference.js';
import { D, round2, sum, toNumber, ZERO } from '../../lib/money.js';
import { dayjs, parseRange } from '../../lib/dates.js';
import { saveSignature } from '../../lib/storage.js';
import { buildInvoicePdf } from '../../lib/pdf.js';
import { getCompanyInfo } from '../settings/setting.service.js';
import { dateSchema, moneySchema, optionalText, uuidSchema } from '../../http.js';

export const paymentMethodSchema = z.enum(['CASH', 'MOBILE_MONEY', 'VIREMENT', 'CHEQUE', 'AUTRE']);

export const saleItemInputSchema = z.object({
  productId: uuidSchema,
  quantity: z.coerce.number().int().positive('La quantite doit etre superieure a zero').max(1_000_000),
  unitPrice: moneySchema.optional(),
});

export const createSaleSchema = z.object({
  clientId: uuidSchema.optional().nullable(),
  type: z.enum(['GROS', 'DETAIL']).default('DETAIL'),
  items: z.array(saleItemInputSchema).min(1, 'Ajoutez au moins un produit'),
  discount: moneySchema.optional().default(0),
  payment: z
    .object({
      amount: moneySchema,
      method: paymentMethodSchema.default('CASH'),
      reference: z.string().trim().max(120).optional().nullable(),
      notes: z.string().trim().max(500).optional().nullable(),
    })
    .optional()
    .nullable(),
  dueDate: dateSchema.optional().nullable(),
  saleDate: dateSchema.optional(),
  notes: optionalText(2000),
  clientRef: z.string().trim().min(1).max(120).optional().nullable(),
  signatureBase64: z.string().max(5_000_000).optional().nullable(),
});

export const addPaymentSchema = z.object({
  amount: moneySchema.refine((value) => value > 0, 'Le montant doit etre superieur a zero'),
  method: paymentMethodSchema.default('CASH'),
  reference: z.string().trim().max(120).optional().nullable(),
  notes: z.string().trim().max(500).optional().nullable(),
  paidAt: dateSchema.optional(),
  clientRef: z.string().trim().min(1).max(120).optional().nullable(),
});

export const saleListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['EN_ATTENTE', 'PARTIELLE', 'PAYEE', 'ANNULEE']).optional(),
  type: z.enum(['GROS', 'DETAIL']).optional(),
  clientId: uuidSchema.optional(),
  userId: uuidSchema.optional(),
  hasBalance: z.enum(['true']).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const cancelSaleSchema = z.object({
  reason: z.string().trim().min(3, 'Motif requis').max(500),
});

export const signSaleSchema = z.object({
  signatureBase64: z.string().min(50, 'Signature requise').max(5_000_000),
});

const saleInclude = {
  client: true,
  user: { select: { id: true, fullName: true, email: true } },
  items: { include: { product: true } },
  payments: { include: { receivedBy: { select: { id: true, fullName: true } } }, orderBy: { paidAt: 'asc' as const } },
  deliveries: true,
} satisfies Prisma.SaleInclude;

const saleDetailInclude = {
  ...saleInclude,
  receipts: true,
} satisfies Prisma.SaleInclude;

export type FullSale = Prisma.SaleGetPayload<{ include: typeof saleDetailInclude }>;

function computeStatus(total: Prisma.Decimal, paid: Prisma.Decimal): 'EN_ATTENTE' | 'PARTIELLE' | 'PAYEE' {
  if (paid.greaterThanOrEqualTo(total)) return 'PAYEE';
  if (paid.greaterThan(0)) return 'PARTIELLE';
  return 'EN_ATTENTE';
}

async function createPaymentRecord(
  tx: Tx,
  input: {
    saleId: string;
    clientId: string | null;
    amount: Prisma.Decimal;
    method: 'CASH' | 'MOBILE_MONEY' | 'VIREMENT' | 'CHEQUE' | 'AUTRE';
    reference?: string | null;
    notes?: string | null;
    receivedById: string;
    paidAt: Date;
    clientRef?: string | null;
    saleReference: string;
  },
) {
  const payment = await tx.payment.create({
    data: {
      saleId: input.saleId,
      clientId: input.clientId,
      amount: input.amount,
      method: input.method,
      reference: input.reference ?? null,
      notes: input.notes ?? null,
      receivedById: input.receivedById,
      paidAt: input.paidAt,
      clientRef: input.clientRef ?? null,
    },
  });

  await tx.receipt.create({
    data: {
      label: `Encaissement vente ${input.saleReference}`,
      amount: input.amount,
      source: 'VENTE',
      saleId: input.saleId,
      paymentId: payment.id,
      receivedById: input.receivedById,
      receiptDate: input.paidAt,
    },
  });

  return payment;
}

export async function getSale(id: string): Promise<FullSale> {
  const sale = await prisma.sale.findUnique({ where: { id }, include: saleDetailInclude });
  if (!sale) throw ApiError.notFound('Vente introuvable');
  return sale;
}

export async function listSales(query: z.infer<typeof saleListQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const hasRange = Boolean(query.from || query.to || query.period);
  const range = hasRange ? parseRange(query) : null;

  const where: Prisma.SaleWhereInput = {
    ...(range ? { saleDate: { gte: range.from, lte: range.to } } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.clientId ? { clientId: query.clientId } : {}),
    ...(query.userId ? { userId: query.userId } : {}),
    ...(query.hasBalance === 'true' ? { balanceDue: { gt: 0 }, status: { not: 'ANNULEE' } } : {}),
    ...(query.search
      ? {
          OR: [
            { reference: { contains: query.search, mode: 'insensitive' as const } },
            { client: { name: { contains: query.search, mode: 'insensitive' as const } } },
            { client: { phone: { contains: query.search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [total, sales] = await Promise.all([
    prisma.sale.count({ where }),
    prisma.sale.findMany({
      where,
      include: {
        client: { select: { id: true, name: true, phone: true } },
        user: { select: { id: true, fullName: true } },
        _count: { select: { items: true, payments: true } },
        deliveries: { select: { id: true, status: true, reference: true } },
      },
      orderBy: { saleDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: sales,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export interface CreateSaleResult {
  sale: FullSale;
  created: boolean;
}

export async function createSale(input: z.infer<typeof createSaleSchema>, actorId: string): Promise<CreateSaleResult> {
  if (input.clientRef) {
    const existing = await prisma.sale.findUnique({ where: { clientRef: input.clientRef }, include: saleDetailInclude });
    if (existing) return { sale: existing, created: false };
  }

  if (input.payment && input.payment.amount > 0 && !input.clientId) {
    // Paiement sans client autorise (client de passage), mais aucun credit ne peut etre ouvert.
  }

  const productIds = input.items.map((item) => item.productId);
  if (new Set(productIds).size !== productIds.length) {
    throw ApiError.badRequest('Un produit apparait plusieurs fois : regroupez les quantites');
  }

  let signatureUrl: string | null = null;
  if (input.signatureBase64) {
    const stored = await saveSignature(input.signatureBase64);
    signatureUrl = stored.url;
  }

  const saleDate = input.saleDate ? dayjs.utc(input.saleDate).toDate() : new Date();
  if (input.dueDate && dayjs.utc(input.dueDate).isBefore(dayjs.utc(saleDate), 'day')) {
    throw ApiError.badRequest('L echeance ne peut pas preceder la date de vente');
  }

  try {
    const sale = await serializableTransaction(async (tx) => {
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
      });
      if (products.length !== productIds.length) {
        throw ApiError.badRequest('Un ou plusieurs produits sont introuvables ou archives');
      }

      const productById = new Map(products.map((product) => [product.id, product]));

      const lines = input.items.map((item) => {
        const product = productById.get(item.productId);
        if (!product) throw ApiError.badRequest('Produit introuvable');
        if (!product.isActive) throw ApiError.badRequest(`Le produit "${product.name}" est desactive`);

        const defaultPrice = input.type === 'GROS' ? product.salePriceGros : product.salePriceDetail;
        const unitPrice = round2(item.unitPrice ?? defaultPrice);
        const lineTotal = round2(unitPrice.times(item.quantity));

        return {
          product,
          quantity: item.quantity,
          unitPrice,
          unitCost: round2(product.costPrice),
          lineTotal,
        };
      });

      const subtotal = sum(lines.map((line) => line.lineTotal));
      const discount = round2(input.discount ?? 0);
      if (discount.greaterThan(subtotal)) throw ApiError.badRequest('La remise ne peut pas depasser le sous-total');

      const totalAmount = round2(subtotal.minus(discount));
      const paidAmount = round2(input.payment?.amount ?? 0);
      if (paidAmount.greaterThan(totalAmount)) {
        throw ApiError.badRequest('Le montant paye ne peut pas depasser le total de la vente');
      }

      const balanceDue = round2(totalAmount.minus(paidAmount));
      const client = input.clientId
        ? await tx.client.findFirst({ where: { id: input.clientId, deletedAt: null } })
        : null;
      if (input.clientId && !client) throw ApiError.badRequest('Client introuvable');

      if (balanceDue.greaterThan(0) && !client) {
        throw ApiError.badRequest('Une vente a credit necessite un client identifie');
      }

      if (client && balanceDue.greaterThan(0) && client.creditLimit.greaterThan(0)) {
        const outstanding = await tx.sale.aggregate({
          where: { clientId: client.id, status: { not: 'ANNULEE' } },
          _sum: { balanceDue: true },
        });
        const currentDebt = outstanding._sum.balanceDue ?? ZERO;

        if (currentDebt.plus(balanceDue).greaterThan(client.creditLimit)) {
          throw ApiError.conflict(
            `Plafond de credit depasse pour ${client.name}. Encours actuel : ${currentDebt.toFixed(2)}, nouvelle dette : ${balanceDue.toFixed(2)}, plafond : ${client.creditLimit.toFixed(2)}`,
            {
              clientId: client.id,
              outstanding: currentDebt.toFixed(2),
              newBalance: balanceDue.toFixed(2),
              creditLimit: client.creditLimit.toFixed(2),
            },
          );
        }
      }

      const cogs = sum(lines.map((line) => round2(line.unitCost.times(line.quantity))));
      const status = computeStatus(totalAmount, paidAmount);
      const dueDate =
        balanceDue.greaterThan(0)
          ? input.dueDate
            ? dayjs.utc(input.dueDate).endOf('day').toDate()
            : dayjs.utc(saleDate).add(30, 'day').toDate()
          : null;

      const created = await tx.sale.create({
        data: {
          reference: makeReference('VTE', saleDate),
          clientId: client?.id ?? null,
          userId: actorId,
          type: input.type,
          status,
          saleDate,
          dueDate,
          subtotal,
          discount,
          totalAmount,
          paidAmount,
          balanceDue,
          cogs,
          signatureUrl,
          signedAt: signatureUrl ? new Date() : null,
          notes: input.notes ?? null,
          clientRef: input.clientRef ?? null,
          items: {
            create: lines.map((line) => ({
              productId: line.product.id,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              unitCost: line.unitCost,
              lineTotal: line.lineTotal,
            })),
          },
        },
      });

      for (const line of lines) {
        await applyStockChange(tx, {
          productId: line.product.id,
          delta: -line.quantity,
          type: 'VENTE',
          unitCost: line.unitCost,
          referenceType: 'sale',
          referenceId: created.id,
          userId: actorId,
          note: `Vente ${created.reference}`,
        });
      }

      if (paidAmount.greaterThan(0) && input.payment) {
        await createPaymentRecord(tx, {
          saleId: created.id,
          clientId: client?.id ?? null,
          amount: paidAmount,
          method: input.payment.method,
          reference: input.payment.reference,
          notes: input.payment.notes,
          receivedById: actorId,
          paidAt: saleDate,
          saleReference: created.reference,
        });
      }

      return tx.sale.findUniqueOrThrow({ where: { id: created.id }, include: saleDetailInclude });
    });

    return { sale, created: true };
  } catch (error) {
    if (input.clientRef && isUniqueConstraintError(error)) {
      const existing = await prisma.sale.findUnique({ where: { clientRef: input.clientRef }, include: saleDetailInclude });
      if (existing) return { sale: existing, created: false };
    }
    throw error;
  }
}

export async function addPayment(saleId: string, input: z.infer<typeof addPaymentSchema>, actorId: string) {
  if (input.clientRef) {
    const existing = await prisma.payment.findUnique({ where: { clientRef: input.clientRef } });
    if (existing) {
      return { payment: existing, sale: await getSale(saleId), created: false };
    }
  }

  try {
    const result = await serializableTransaction(async (tx) => {
      const sale = await tx.sale.findUnique({ where: { id: saleId } });
      if (!sale) throw ApiError.notFound('Vente introuvable');
      if (sale.status === 'ANNULEE') throw ApiError.conflict('Impossible d encaisser une vente annulee');
      if (sale.balanceDue.lessThanOrEqualTo(0)) throw ApiError.conflict('Cette vente est deja entierement payee');

      const amount = round2(input.amount);
      if (amount.greaterThan(sale.balanceDue)) {
        throw ApiError.badRequest(`Le montant depasse le solde restant (${sale.balanceDue.toFixed(2)})`);
      }

      const payment = await createPaymentRecord(tx, {
        saleId: sale.id,
        clientId: sale.clientId,
        amount,
        method: input.method,
        reference: input.reference,
        notes: input.notes,
        receivedById: actorId,
        paidAt: input.paidAt ? dayjs.utc(input.paidAt).toDate() : new Date(),
        clientRef: input.clientRef ?? null,
        saleReference: sale.reference,
      });

      const newPaid = round2(sale.paidAmount.plus(amount));
      const newBalance = round2(sale.balanceDue.minus(amount));

      const updated = await tx.sale.update({
        where: { id: sale.id },
        data: {
          paidAmount: newPaid,
          balanceDue: newBalance,
          status: computeStatus(sale.totalAmount, newPaid),
        },
        include: saleDetailInclude,
      });

      return { payment, sale: updated, created: true };
    });

    return result;
  } catch (error) {
    if (input.clientRef && isUniqueConstraintError(error)) {
      const existing = await prisma.payment.findUnique({ where: { clientRef: input.clientRef } });
      if (existing) return { payment: existing, sale: await getSale(saleId), created: false };
    }
    throw error;
  }
}

export async function cancelSale(saleId: string, reason: string): Promise<FullSale> {
  return serializableTransaction(async (tx) => {
    const sale = await tx.sale.findUnique({ where: { id: saleId }, include: { items: true } });
    if (!sale) throw ApiError.notFound('Vente introuvable');
    if (sale.status === 'ANNULEE') throw ApiError.conflict('Cette vente est deja annulee');

    for (const item of sale.items) {
      await applyStockChange(tx, {
        productId: item.productId,
        delta: item.quantity,
        type: 'ANNULATION_VENTE',
        unitCost: item.unitCost,
        referenceType: 'sale',
        referenceId: sale.id,
        userId: sale.userId,
        note: `Annulation vente ${sale.reference}`,
      });
    }

    return tx.sale.update({
      where: { id: sale.id },
      data: {
        status: 'ANNULEE',
        cancelledAt: new Date(),
        cancelReason: reason,
        balanceDue: ZERO,
      },
      include: saleDetailInclude,
    });
  });
}

export async function signSale(saleId: string, signatureBase64: string): Promise<FullSale> {
  const sale = await prisma.sale.findUnique({ where: { id: saleId }, select: { id: true } });
  if (!sale) throw ApiError.notFound('Vente introuvable');

  const stored = await saveSignature(signatureBase64);

  return prisma.sale.update({
    where: { id: saleId },
    data: { signatureUrl: stored.url, signedAt: new Date() },
    include: saleDetailInclude,
  });
}

export async function getInvoicePdf(saleId: string): Promise<Buffer> {
  const [sale, company] = await Promise.all([getSale(saleId), getCompanyInfo()]);
  return buildInvoicePdf(sale, company);
}

export async function getSaleSummary(saleId: string) {
  const sale = await getSale(saleId);
  return {
    id: sale.id,
    reference: sale.reference,
    client: sale.client,
    totalAmount: sale.totalAmount,
    paidAmount: sale.paidAmount,
    balanceDue: sale.balanceDue,
    cogs: sale.cogs,
    margin: round2(sale.totalAmount.minus(sale.cogs)),
    itemCount: sale.items.length,
    paymentsCount: sale.payments.length,
  };
}

export function computeSaleTotals(items: { quantity: number; unitPrice: number | string; unitCost: number | string }[], discount = 0) {
  const subtotal = sum(items.map((item) => D(item.unitPrice).times(item.quantity)));
  const cogs = sum(items.map((item) => D(item.unitCost).times(item.quantity)));
  const total = round2(subtotal.minus(discount));
  return { subtotal, total, cogs, margin: round2(total.minus(cogs)), subtotalNumber: toNumber(subtotal) };
}
