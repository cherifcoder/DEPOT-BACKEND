import { env } from '../env.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

interface PushMessage {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoTicket {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_BATCH = 100;

function isExpoToken(token: string): boolean {
  return /^(Expo|Exponent)PushToken\[[^\]]+\]$/.test(token);
}

/**
 * Envoi de notifications push via l'API Expo (sans SDK, compatible Node 24).
 * Les erreurs sont non bloquantes : les notifications restent consultables dans l'app.
 */
export async function sendPushToUsers(userIds: string[], message: PushMessage): Promise<void> {
  const uniqueUserIds = [...new Set(userIds)];
  if (uniqueUserIds.length === 0) return;

  const tokens = await prisma.pushToken.findMany({
    where: { userId: { in: uniqueUserIds } },
    select: { id: true, token: true },
  });

  const validTokens = tokens.filter((entry) => isExpoToken(entry.token));
  if (validTokens.length === 0) return;

  const invalidIds: string[] = [];

  for (let index = 0; index < validTokens.length; index += MAX_BATCH) {
    const batch = validTokens.slice(index, index + MAX_BATCH);

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Accept-Encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
          ...(env.EXPO_ACCESS_TOKEN ? { Authorization: `Bearer ${env.EXPO_ACCESS_TOKEN}` } : {}),
        },
        body: JSON.stringify(
          batch.map((entry) => ({
            to: entry.token,
            sound: 'default',
            title: message.title,
            body: message.body,
            data: message.data ?? {},
            priority: 'high',
            channelId: 'default',
          })),
        ),
      });

      if (!response.ok) {
        logger.warn({ status: response.status }, 'Echec de l envoi des notifications push');
        continue;
      }

      const payload = (await response.json()) as { data?: ExpoTicket[] };
      const tickets = payload.data ?? [];

      tickets.forEach((ticket, ticketIndex) => {
        const target = batch[ticketIndex];
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered' && target) {
          invalidIds.push(target.id);
        }
      });
    } catch (error) {
      logger.warn({ error }, 'Erreur reseau lors de l envoi push');
    }
  }

  if (invalidIds.length > 0) {
    await prisma.pushToken.deleteMany({ where: { id: { in: invalidIds } } });
  }
}
