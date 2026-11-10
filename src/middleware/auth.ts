import type { NextFunction, Request, Response } from 'express';
import type { Role } from '@prisma/client';
import { ApiError } from '../lib/errors.js';
import { verifyAccessToken } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';

/** Verifie le JWT, recharge l'utilisateur et applique la revocation de session. */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    throw ApiError.unauthorized('Token d acces manquant');
  }

  const payload = verifyAccessToken(header.slice('Bearer '.length).trim());

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, isActive: true, deletedAt: null },
    include: { roles: true },
  });

  if (!user) throw ApiError.unauthorized('Compte inactif ou introuvable');
  if (user.tokenVersion !== payload.tokenVersion) {
    throw ApiError.unauthorized('Session revoquee, veuillez vous reconnecter');
  }

  req.user = {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    roles: user.roles.map((entry) => entry.role),
    tokenVersion: user.tokenVersion,
  };

  next();
}

/** ADMIN a toujours acces. Les autres roles doivent correspondre a la liste. */
export function requireRoles(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw ApiError.unauthorized();
    const allowed = req.user.roles.includes('ADMIN') || roles.some((role) => req.user?.roles.includes(role));

    if (!allowed) {
      throw ApiError.forbidden(`Acces reserve aux profils : ${roles.join(', ')}`);
    }
    next();
  };
}

export function requireAdmin() {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw ApiError.unauthorized();
    if (!req.user.roles.includes('ADMIN')) throw ApiError.forbidden('Acces reserve aux administrateurs');
    next();
  };
}
