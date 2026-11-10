import { z } from 'zod';
import type { Role } from '@prisma/client';
import { ApiError } from '../../lib/errors.js';
import { hashPassword } from '../../lib/password.js';
import { prisma } from '../../lib/prisma.js';
import { randomPassword } from '../../lib/reference.js';
import { passwordSchema } from '../../http.js';
import { serializeUser } from './user.serializer.js';

const roleSchema = z.enum(['ADMIN', 'VENDEUR', 'COMPTABLE', 'LIVREUR']);

export const createUserSchema = z.object({
  fullName: z.string().trim().min(2, 'Nom complet requis').max(120),
  email: z.email('Adresse email invalide').trim().toLowerCase(),
  phone: z.string().trim().max(30).optional().nullable(),
  password: passwordSchema,
  roles: z.array(roleSchema).min(1, 'Selectionnez au moins un role'),
  mustChangePassword: z.boolean().optional().default(true),
});

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  email: z.email().trim().toLowerCase().optional(),
  phone: z.string().trim().max(30).optional().nullable(),
  roles: z.array(roleSchema).min(1).optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
});

export const resetPasswordSchema = z.object({
  newPassword: passwordSchema.optional(),
});

export const listUsersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  role: roleSchema.optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

async function countActiveAdmins(excludeUserId?: string): Promise<number> {
  return prisma.user.count({
    where: {
      isActive: true,
      deletedAt: null,
      ...(excludeUserId ? { id: { not: excludeUserId } } : {}),
      roles: { some: { role: 'ADMIN' } },
    },
  });
}

function uniqueRoles(roles: Role[]): Role[] {
  return [...new Set(roles)];
}

export async function listUsers(query: z.infer<typeof listUsersQuerySchema>) {
  const where = {
    deletedAt: null,
    ...(query.search
      ? {
          OR: [
            { fullName: { contains: query.search, mode: 'insensitive' as const } },
            { email: { contains: query.search, mode: 'insensitive' as const } },
            { phone: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(query.role ? { roles: { some: { role: query.role } } } : {}),
    ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
  };

  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      include: { roles: true },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: users.map(serializeUser),
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getUser(id: string) {
  const user = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    include: {
      roles: true,
      _count: { select: { sales: true, deliveries: true, payments: true } },
    },
  });

  if (!user) throw ApiError.notFound('Utilisateur introuvable');
  return { ...serializeUser(user), counts: user._count };
}

export async function createUser(input: z.infer<typeof createUserSchema>) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw ApiError.conflict('Un utilisateur utilise deja cet email');

  const roles = uniqueRoles(input.roles);
  const user = await prisma.user.create({
    data: {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone ?? null,
      passwordHash: await hashPassword(input.password),
      mustChangePassword: input.mustChangePassword,
      roles: { create: roles.map((role) => ({ role })) },
    },
    include: { roles: true },
  });

  return serializeUser(user);
}

export async function updateUser(id: string, input: z.infer<typeof updateUserSchema>, actorId: string) {
  const target = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    include: { roles: true },
  });
  if (!target) throw ApiError.notFound('Utilisateur introuvable');

  if (input.email && input.email !== target.email) {
    const existing = await prisma.user.findUnique({ where: { email: input.email } });
    if (existing && existing.id !== id) throw ApiError.conflict('Cet email est deja utilise');
  }

  if (id === actorId && input.isActive === false) {
    throw ApiError.badRequest('Vous ne pouvez pas desactiver votre propre compte');
  }

  const targetIsAdmin = target.roles.some((entry) => entry.role === 'ADMIN');
  const losesAdminRole = input.roles !== undefined && targetIsAdmin && !input.roles.includes('ADMIN');

  if (id === actorId && losesAdminRole) {
    throw ApiError.badRequest('Vous ne pouvez pas retirer votre propre role administrateur');
  }

  if ((losesAdminRole || input.isActive === false) && targetIsAdmin) {
    const remaining = await countActiveAdmins(id);
    if (remaining < 1) throw ApiError.conflict('Au moins un administrateur actif est requis');
  }

  return prisma.$transaction(async (tx) => {
    if (input.roles) {
      const roles = uniqueRoles(input.roles);
      await tx.userRole.deleteMany({ where: { userId: id } });
      await tx.userRole.createMany({ data: roles.map((role) => ({ userId: id, role })) });
    }

    const user = await tx.user.update({
      where: { id },
      data: {
        fullName: input.fullName,
        email: input.email,
        phone: input.phone,
        isActive: input.isActive,
        mustChangePassword: input.mustChangePassword,
        ...(input.isActive === false
          ? { deletedAt: new Date(), tokenVersion: { increment: 1 } }
          : input.isActive === true
            ? { deletedAt: null }
            : {}),
      },
      include: { roles: true },
    });

    if (input.isActive === false || input.roles) {
      await tx.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    return serializeUser(user);
  });
}

export async function resetUserPassword(id: string, newPassword?: string) {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!user) throw ApiError.notFound('Utilisateur introuvable');

  const generated = newPassword ? null : randomPassword(14);
  const password = newPassword ?? generated ?? randomPassword(14);

  await prisma.$transaction([
    prisma.user.update({
      where: { id },
      data: {
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        tokenVersion: { increment: 1 },
      },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  return { generatedPassword: generated };
}

export async function revokeUserSessions(id: string): Promise<void> {
  const user = await prisma.user.findFirst({ where: { id, deletedAt: null } });
  if (!user) throw ApiError.notFound('Utilisateur introuvable');

  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.user.update({ where: { id }, data: { tokenVersion: { increment: 1 } } }),
  ]);
}
