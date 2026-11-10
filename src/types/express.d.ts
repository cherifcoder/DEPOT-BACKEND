import type { Role } from '@prisma/client';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  roles: Role[];
  tokenVersion: number;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export {};
