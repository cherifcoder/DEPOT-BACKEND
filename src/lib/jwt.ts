import type { Role } from '@prisma/client';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../env.js';
import { ApiError } from './errors.js';

export interface AccessTokenPayload {
  sub: string;
  roles: Role[];
  tokenVersion: number;
  type: 'access';
}

export function signAccessToken(payload: Omit<AccessTokenPayload, 'type'>): string {
  return jwt.sign({ ...payload, type: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as SignOptions['expiresIn'],
    issuer: 'depot-boissons-api',
    audience: 'depot-boissons-mobile',
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      issuer: 'depot-boissons-api',
      audience: 'depot-boissons-mobile',
    });

    if (typeof decoded === 'string' || decoded.type !== 'access' || !decoded.sub) {
      throw new Error('Payload invalide');
    }

    return {
      sub: String(decoded.sub),
      roles: Array.isArray(decoded.roles) ? (decoded.roles as Role[]) : [],
      tokenVersion: Number(decoded.tokenVersion ?? 0),
      type: 'access',
    };
  } catch {
    throw ApiError.unauthorized('Session expiree ou token invalide');
  }
}
