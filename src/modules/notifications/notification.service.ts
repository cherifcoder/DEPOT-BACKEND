import { z } from 'zod';
import type { NotificationType, Role } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { sendPushToUsers } from '../../lib/push.js';
import { paginated, parsePagination } from '../../lib/pagination.js';

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function notifyUsers(userIds: string[], input: NotifyInput): Promise<void> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0) return;

  await prisma.notification.createMany({
    data: unique.map((userId) => ({
      userId,
      type: input.type,
      title: input.title,
      body: input.body,
      data: (input.data ?? {}) as object,
    })),
  });

  void sendPushToUsers(unique, { title: input.title, body: input.body, data: input.data }).catch(() => {
    // Les notifications restent consultables dans l'application meme si le push echoue.
  });
}

export async function notifyRoles(roles: Role[], input: NotifyInput): Promise<void> {
  const users = await prisma.user.findMany({
    where: {
      isActive: true,
      deletedAt: null,
      roles: { some: { role: { in: roles } } },
    },
    select: { id: true },
  });

  await notifyUsers(users.map((user) => user.id), input);
}

export async function listNotifications(userId: string, query: { page?: number; limit?: number; unread?: boolean }) {
  const pagination = parsePagination(query as Record<string, unknown>, 30, 100);
  const where = { userId, ...(query.unread ? { isRead: false } : {}) };

  const [total, notifications, unreadCount] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.notification.count({ where: { userId, isRead: false } }),
  ]);

  return { ...paginated(notifications, total, pagination), unreadCount };
}

export async function markNotificationRead(userId: string, id: string) {
  return prisma.notification.updateMany({
    where: { id, userId },
    data: { isRead: true, readAt: new Date() },
  });
}

export async function markAllNotificationsRead(userId: string) {
  return prisma.notification.updateMany({
    where: { userId, isRead: false },
    data: { isRead: true, readAt: new Date() },
  });
}

export async function registerPushToken(userId: string, token: string, platform: string) {
  return prisma.pushToken.upsert({
    where: { token },
    update: { userId, platform, lastUsedAt: new Date() },
    create: { userId, token, platform },
  });
}

export async function removePushToken(userId: string, token: string) {
  await prisma.pushToken.deleteMany({ where: { userId, token } });
}

export const pushTokenSchema = z.object({
  token: z.string().min(10).max(300),
  platform: z.enum(['android', 'ios', 'web']),
});
