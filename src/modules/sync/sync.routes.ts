import { Router } from 'express';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { authenticate } from '../../middleware/auth.js';
import { parseBody, requireUser, uuidSchema } from '../../http.js';
import { prisma } from '../../lib/prisma.js';
import { dayjs } from '../../lib/dates.js';
import { recordAudit } from '../../lib/audit.js';
import { ApiError } from '../../lib/errors.js';
import { createSale, createSaleSchema, addPayment, addPaymentSchema } from '../sales/sale.service.js';
import { createLoss, createLossSchema } from '../losses/loss.service.js';
import { createExpense, createExpenseSchema } from '../expenses/expense.service.js';
import { createDelivery, createDeliverySchema } from '../deliveries/delivery.service.js';
import { getSettings } from '../settings/setting.service.js';

const operationSchema = z.object({
  id: z.string().min(1).max(120),
  entity: z.enum(['sale', 'payment', 'loss', 'expense', 'delivery']),
  payload: z.record(z.string(), z.unknown()),
});

const pushSchema = z.object({
  operations: z.array(operationSchema).min(1).max(50),
});

type SyncEntity = z.infer<typeof operationSchema>['entity'];

const SYNC_ENTITY_ROLES: Record<SyncEntity, Role[]> = {
  sale: ['VENDEUR', 'COMPTABLE'],
  payment: ['VENDEUR', 'COMPTABLE'],
  loss: ['VENDEUR', 'COMPTABLE'],
  expense: ['COMPTABLE'],
  delivery: ['VENDEUR', 'COMPTABLE', 'LIVREUR'],
};

/** Memes droits que les routes directes : ADMIN est toujours autorise. */
export function canSyncEntity(roles: Role[], entity: SyncEntity): boolean {
  if (roles.includes('ADMIN')) return true;
  return SYNC_ENTITY_ROLES[entity].some((role) => roles.includes(role));
}

function isDriverOnly(roles: Role[]): boolean {
  return roles.includes('LIVREUR') && !roles.some((role) => role === 'ADMIN' || role === 'VENDEUR' || role === 'COMPTABLE');
}

export const syncRouter = Router();
syncRouter.use(authenticate);

/** Rejoue une file d operations hors-ligne, de maniere idempotente (clientRef). */
syncRouter.post('/push', async (req, res) => {
  const actor = requireUser(req);
  const { operations } = parseBody(pushSchema, req);
  res.locals.skipAudit = true;

  const results: Array<{
    id: string;
    entity: string;
    ok: boolean;
    resourceId?: string;
    created?: boolean;
    error?: { code: string; message: string };
  }> = [];

  for (const operation of operations) {
    const clientRef = typeof operation.payload.clientRef === 'string' ? operation.payload.clientRef : operation.id;

    try {
      if (!canSyncEntity(actor.roles, operation.entity)) {
        throw ApiError.forbidden(`Votre profil ne peut pas synchroniser une operation de type ${operation.entity}`);
      }

      if (operation.entity === 'sale') {
        const input = createSaleSchema.parse({ ...operation.payload, clientRef });
        const { sale, created } = await createSale(input, actor.id);
        results.push({ id: operation.id, entity: 'sale', ok: true, resourceId: sale.id, created });
        await recordAudit(req, {
          action: 'CREATE',
          entity: 'sales',
          entityId: sale.id,
          after: { reference: sale.reference, totalAmount: sale.totalAmount, balanceDue: sale.balanceDue, clientRef },
          metadata: { source: 'offline_sync', created },
        });
      } else if (operation.entity === 'payment') {
        const saleId = uuidSchema.parse(operation.payload.saleId);
        const input = addPaymentSchema.parse({ ...operation.payload, clientRef });
        const { payment, sale, created } = await addPayment(saleId, input, actor.id);
        results.push({ id: operation.id, entity: 'payment', ok: true, resourceId: payment.id, created });
        await recordAudit(req, {
          action: 'CREATE',
          entity: 'payments',
          entityId: payment.id,
          after: { saleId, amount: payment.amount, balanceDue: sale.balanceDue, clientRef },
          metadata: { source: 'offline_sync', created },
        });
      } else if (operation.entity === 'loss') {
        const input = createLossSchema.parse({ ...operation.payload, clientRef });
        const { loss, created } = await createLoss(input, actor.id);
        results.push({ id: operation.id, entity: 'loss', ok: true, resourceId: loss.id, created });
        await recordAudit(req, {
          action: 'CREATE',
          entity: 'losses',
          entityId: loss.id,
          after: { reference: loss.reference, quantity: loss.quantity, totalCost: loss.totalCost },
          metadata: { source: 'offline_sync', created },
        });
      } else if (operation.entity === 'expense') {
        const input = createExpenseSchema.parse({ ...operation.payload, clientRef });
        const { expense, created } = await createExpense(input, actor.id);
        results.push({ id: operation.id, entity: 'expense', ok: true, resourceId: expense.id, created });
        await recordAudit(req, {
          action: 'CREATE',
          entity: 'expenses',
          entityId: expense.id,
          after: { description: expense.description, amount: expense.amount, clientRef },
          metadata: { source: 'offline_sync', created },
        });
      } else {
        const input = createDeliverySchema.parse({ ...operation.payload, clientRef });
        if (isDriverOnly(actor.roles)) input.livreurId = actor.id;
        const { delivery, created } = await createDelivery(input, actor.id);
        results.push({ id: operation.id, entity: 'delivery', ok: true, resourceId: delivery.id, created });
        await recordAudit(req, {
          action: 'CREATE',
          entity: 'deliveries',
          entityId: delivery.id,
          after: { reference: delivery.reference, destination: delivery.destination, clientRef },
          metadata: { source: 'offline_sync', created },
        });
      }
    } catch (error) {
      const apiError = error instanceof ApiError ? error : null;
      results.push({
        id: operation.id,
        entity: operation.entity,
        ok: false,
        error: {
          code: apiError?.code ?? 'SYNC_ERROR',
          message: apiError?.message ?? (error instanceof Error ? error.message : 'Operation impossible'),
        },
      });
    }
  }

  res.json({
    results,
    succeeded: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    serverTime: new Date().toISOString(),
  });
});

/** Synchronisation descendante : donnees modifiees depuis la derniere synchro. */
syncRouter.get('/pull', async (req, res) => {
  res.locals.skipAudit = true;
  const sinceRaw = typeof req.query.since === 'string' ? req.query.since : null;
  const since = sinceRaw && dayjs.utc(sinceRaw).isValid() ? dayjs.utc(sinceRaw).toDate() : null;
  const updatedFilter = since ? { updatedAt: { gt: since } } : {};

  const [products, categories, clients, sales, deliveries, settings] = await Promise.all([
    prisma.product.findMany({
      where: { deletedAt: null, ...updatedFilter },
      include: { category: true },
      orderBy: { name: 'asc' },
      take: 2000,
    }),
    prisma.productCategory.findMany({ orderBy: { name: 'asc' } }),
    prisma.client.findMany({
      where: since ? { OR: [{ updatedAt: { gt: since } }, { deletedAt: { gt: since } }] } : {},
      orderBy: { name: 'asc' },
      take: 2000,
    }),
    prisma.sale.findMany({
      where: since ? { updatedAt: { gt: since } } : {},
      include: {
        client: { select: { id: true, name: true, phone: true, address: true } },
        user: { select: { id: true, fullName: true } },
        items: { include: { product: { select: { id: true, name: true, sku: true, imageUrl: true } } } },
        payments: true,
        deliveries: { select: { id: true, reference: true, status: true } },
      },
      orderBy: { saleDate: 'desc' },
      take: since ? 300 : 100,
    }),
    prisma.delivery.findMany({
      where: since ? { updatedAt: { gt: since } } : { status: { in: ['EN_COURS', 'LIVRE'] } },
      include: {
        client: { select: { id: true, name: true, phone: true, address: true } },
        sale: { select: { id: true, reference: true, balanceDue: true } },
        product: { select: { id: true, name: true, sku: true } },
        livreur: { select: { id: true, fullName: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
    }),
    getSettings(),
  ]);

  res.json({
    serverTime: new Date().toISOString(),
    since,
    products,
    categories,
    clients,
    sales,
    deliveries,
    settings,
  });
});
