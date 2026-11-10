import type { NotificationType, Prisma, Role } from '@prisma/client';
import nodeCron, { type ScheduledTask } from 'node-cron';
import { env } from '../env.js';
import { dayjs } from '../lib/dates.js';
import { D, formatMoney, sum } from '../lib/money.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { getSettings } from '../modules/settings/setting.service.js';
import { notifyRoles } from '../modules/notifications/notification.service.js';

export interface NotificationJobResult {
  stockBas: boolean;
  creancesEchues: boolean;
  livraisonsRetard: boolean;
}

const JOB_TYPES: NotificationType[] = ['STOCK_BAS', 'DETTE_ECHEANCE', 'LIVRAISON_RETARD'];

function readDedupeKey(data: Prisma.JsonValue | null): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const key = (data as Record<string, unknown>).dedupeKey;
  return typeof key === 'string' ? key : null;
}

/** Notifications deja envoyees aujourd'hui, indexees par "TYPE:cle". */
async function sentKeysToday(since: Date): Promise<Set<string>> {
  const notifications = await prisma.notification.findMany({
    where: { type: { in: JOB_TYPES }, createdAt: { gte: since } },
    select: { type: true, data: true },
  });

  const keys = new Set<string>();
  for (const notification of notifications) {
    const key = readDedupeKey(notification.data);
    if (key) keys.add(`${notification.type}:${key}`);
  }
  return keys;
}

function alreadySent(sent: Set<string>, type: NotificationType, key: string): boolean {
  return sent.has(`${type}:${key}`);
}

function markSent(sent: Set<string>, type: NotificationType, key: string): void {
  sent.add(`${type}:${key}`);
}

async function alertLowStock(sent: Set<string>, currency: string): Promise<boolean> {
  const key = 'stock-bas';
  if (alreadySent(sent, 'STOCK_BAS', key)) return false;

  const products = await prisma.product.findMany({
    where: { isActive: true, deletedAt: null, minStockQty: { gt: 0 } },
    select: { id: true, name: true, sku: true, stockQty: true, minStockQty: true },
    orderBy: { stockQty: 'asc' },
  });

  const low = products.filter((product) => product.stockQty <= product.minStockQty);
  if (low.length === 0) return false;

  const preview = low
    .slice(0, 5)
    .map((product) => `${product.name} (${product.stockQty}/${product.minStockQty})`)
    .join(', ');
  const suffix = low.length > 5 ? ` et ${low.length - 5} autre(s)` : '';

  await notifyRoles(['ADMIN', 'COMPTABLE', 'VENDEUR'] as Role[], {
    type: 'STOCK_BAS',
    title: `Stock bas : ${low.length} produit(s) a reapprovisionner`,
    body: `${preview}${suffix}. Devise : ${currency}.`,
    data: {
      dedupeKey: key,
      productIds: low.slice(0, 20).map((product) => product.id),
      count: low.length,
    },
  });

  markSent(sent, 'STOCK_BAS', key);
  return true;
}

async function alertOverdueDebts(sent: Set<string>, currency: string): Promise<boolean> {
  const key = 'creances-echues';
  if (alreadySent(sent, 'DETTE_ECHEANCE', key)) return false;

  const now = new Date();
  const overdue = await prisma.sale.findMany({
    where: {
      status: { in: ['EN_ATTENTE', 'PARTIELLE'] },
      balanceDue: { gt: 0 },
      dueDate: { not: null, lt: now },
    },
    select: {
      id: true,
      reference: true,
      balanceDue: true,
      dueDate: true,
      client: { select: { id: true, name: true } },
    },
    orderBy: { dueDate: 'asc' },
  });

  if (overdue.length === 0) return false;

  const total = sum(overdue.map((sale) => sale.balanceDue));
  const clients = new Set(overdue.map((sale) => sale.client?.id).filter(Boolean)).size;
  const oldest = overdue[0]?.dueDate ? dayjs.utc(overdue[0].dueDate).format('DD/MM/YYYY') : '-';

  await notifyRoles(['ADMIN', 'COMPTABLE'] as Role[], {
    type: 'DETTE_ECHEANCE',
    title: `Creances echues : ${formatMoney(total, currency)}`,
    body: `${overdue.length} facture(s) en retard pour ${clients} client(s). Echeance la plus ancienne : ${oldest}.`,
    data: {
      dedupeKey: key,
      total: D(total).toFixed(2),
      saleIds: overdue.slice(0, 50).map((sale) => sale.id),
      count: overdue.length,
    },
  });

  markSent(sent, 'DETTE_ECHEANCE', key);
  return true;
}

async function alertLateDeliveries(sent: Set<string>): Promise<boolean> {
  const key = 'livraisons-retard';
  if (alreadySent(sent, 'LIVRAISON_RETARD', key)) return false;

  const now = new Date();
  const late = await prisma.delivery.findMany({
    where: {
      status: 'EN_COURS',
      scheduledAt: { not: null, lt: now },
    },
    select: {
      id: true,
      reference: true,
      destination: true,
      scheduledAt: true,
      livreur: { select: { id: true, fullName: true } },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  if (late.length === 0) return false;

  const preview = late
    .slice(0, 5)
    .map((delivery) => `${delivery.reference} - ${delivery.destination}`)
    .join(', ');
  const suffix = late.length > 5 ? ` et ${late.length - 5} autre(s)` : '';

  await notifyRoles(['ADMIN', 'VENDEUR', 'LIVREUR'] as Role[], {
    type: 'LIVRAISON_RETARD',
    title: `${late.length} livraison(s) en retard`,
    body: `${preview}${suffix}.`,
    data: {
      dedupeKey: key,
      deliveryIds: late.slice(0, 50).map((delivery) => delivery.id),
      count: late.length,
    },
  });

  markSent(sent, 'LIVRAISON_RETARD', key);
  return true;
}

/**
 * Genere les alertes quotidiennes (stock bas, creances echues, livraisons en retard).
 * Chaque alerte n'est emise qu'une fois par jour (cle de deduplication stockee dans `data`).
 */
export async function runNotificationJob(): Promise<NotificationJobResult> {
  const settings = await getSettings().catch(() => null);
  const currency = settings?.currency ?? 'XOF';
  const since = dayjs.utc().startOf('day').toDate();
  const sent = await sentKeysToday(since);

  const result: NotificationJobResult = {
    stockBas: false,
    creancesEchues: false,
    livraisonsRetard: false,
  };

  try {
    if (settings?.lowStockAlerts !== false) {
      result.stockBas = await alertLowStock(sent, currency);
    }
    result.creancesEchues = await alertOverdueDebts(sent, currency);
    result.livraisonsRetard = await alertLateDeliveries(sent);
  } catch (error) {
    logger.error({ error }, 'Echec du job de notifications');
  }

  return result;
}

let scheduledTask: ScheduledTask | null = null;

/** Planifie l'execution quotidienne (08:00 par defaut, fuseau configure). */
export function startNotificationJob(): ScheduledTask {
  if (scheduledTask) return scheduledTask;

  scheduledTask = nodeCron.schedule('0 8 * * *', async () => {
    const result = await runNotificationJob();
    logger.info(result, 'Job de notifications termine');
  }, {
    timezone: env.CRON_TIMEZONE,
    name: 'notifications-quotidiennes',
    noOverlap: true,
  });

  logger.info({ timezone: env.CRON_TIMEZONE }, 'Job de notifications planifie (quotidien 08:00)');
  return scheduledTask;
}

export function stopNotificationJob(): void {
  if (!scheduledTask) return;
  scheduledTask.stop();
  scheduledTask = null;
}
