import type { Request } from 'express';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { ApiError } from '../../lib/errors.js';
import { recordAuthAudit } from '../../lib/audit.js';
import { hashPassword, sha256, verifyPassword } from '../../lib/password.js';
import { randomToken } from '../../lib/reference.js';
import { signAccessToken } from '../../lib/jwt.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../env.js';
import { serializeUser, type PublicUser } from '../users/user.serializer.js';
import { passwordSchema } from '../../http.js';

export const loginSchema = z.object({
  email: z.email('Adresse email invalide').trim().toLowerCase(),
  password: z.string().min(1, 'Mot de passe requis'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(20).optional(),
  allDevices: z.boolean().optional().default(false),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

export interface AuthResult {
  accessToken: string;
  refreshToken: string;
  user: PublicUser;
}

function userWithRoles(userId: string) {
  return prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { roles: true },
  });
}

async function issueRefreshToken(userId: string, req: Request): Promise<string> {
  const token = randomToken(48);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(token),
      expiresAt,
      ipAddress: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null,
    },
  });

  return token;
}

export async function login(input: z.infer<typeof loginSchema>, req: Request): Promise<AuthResult> {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
    include: { roles: true },
  });

  if (!user || user.deletedAt) {
    await recordAuthAudit(req, {
      action: 'LOGIN_FAILED',
      userId: user?.id ?? null,
      userName: user?.fullName ?? input.email,
      metadata: { email: input.email, reason: 'unknown_user' },
    });
    throw ApiError.unauthorized('Email ou mot de passe incorrect');
  }

  if (!user.isActive) {
    await recordAuthAudit(req, {
      action: 'LOGIN_FAILED',
      userId: user.id,
      userName: user.fullName,
      metadata: { reason: 'inactive_account' },
    });
    throw ApiError.forbidden('Compte desactive. Contactez un administrateur.');
  }

  const valid = await verifyPassword(input.password, user.passwordHash);
  if (!valid) {
    await recordAuthAudit(req, {
      action: 'LOGIN_FAILED',
      userId: user.id,
      userName: user.fullName,
      metadata: { reason: 'bad_password' },
    });
    throw ApiError.unauthorized('Email ou mot de passe incorrect');
  }

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
    include: { roles: true },
  });

  const roles = updated.roles.map((entry) => entry.role);
  const accessToken = signAccessToken({ sub: updated.id, roles, tokenVersion: updated.tokenVersion });
  const refreshToken = await issueRefreshToken(updated.id, req);

  await recordAuthAudit(req, {
    action: 'LOGIN',
    userId: updated.id,
    userName: updated.fullName,
    metadata: { roles },
  });

  return { accessToken, refreshToken, user: serializeUser(updated) };
}

export async function refresh(input: z.infer<typeof refreshSchema>, req: Request): Promise<AuthResult> {
  const tokenHash = sha256(input.refreshToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: { include: { roles: true } } },
  });

  if (!stored) throw ApiError.unauthorized('Session invalide');

  // Reutilisation d'un token deja tourne : compromission probable -> revocation globale.
  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.user.update({
      where: { id: stored.userId },
      data: { tokenVersion: { increment: 1 } },
    });
    throw ApiError.unauthorized('Session compromise, reconnexion requise');
  }

  if (stored.expiresAt.getTime() < Date.now()) {
    throw ApiError.unauthorized('Session expiree, reconnexion requise');
  }

  if (!stored.user.isActive || stored.user.deletedAt) {
    throw ApiError.forbidden('Compte inactif');
  }

  const newToken = randomToken(48);
  const newHash = sha256(newToken);
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date(), replacedBy: newHash },
    }),
    prisma.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: newHash,
        expiresAt,
        ipAddress: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
      },
    }),
  ]);

  const roles: Role[] = stored.user.roles.map((entry) => entry.role);
  const accessToken = signAccessToken({
    sub: stored.user.id,
    roles,
    tokenVersion: stored.user.tokenVersion,
  });

  return { accessToken, refreshToken: newToken, user: serializeUser(stored.user) };
}

export async function logout(
  userId: string,
  input: z.infer<typeof logoutSchema>,
  req: Request,
): Promise<void> {
  if (input.allDevices) {
    await revokeAllSessions(userId);
  } else if (input.refreshToken) {
    await prisma.refreshToken.updateMany({
      where: { userId, tokenHash: sha256(input.refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } });
  await recordAuthAudit(req, {
    action: 'LOGOUT',
    userId,
    userName: user?.fullName ?? 'Utilisateur',
    metadata: { allDevices: input.allDevices },
  });
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await prisma.$transaction([
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
    prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } }),
  ]);
}

export async function changePassword(
  userId: string,
  input: z.infer<typeof changePasswordSchema>,
): Promise<void> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  const valid = await verifyPassword(input.currentPassword, user.passwordHash);
  if (!valid) throw ApiError.badRequest('Mot de passe actuel incorrect');

  if (input.currentPassword === input.newPassword) {
    throw ApiError.badRequest('Le nouveau mot de passe doit etre different');
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      mustChangePassword: false,
      tokenVersion: { increment: 1 },
    },
  });

  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await userWithRoles(userId);
  return serializeUser(user);
}
