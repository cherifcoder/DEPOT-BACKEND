import { Prisma, type PrismaClient } from '@prisma/client';
import { isWriteConflict } from './errors.js';
import { prisma } from './prisma.js';

export type Tx = Prisma.TransactionClient;

const MAX_ATTEMPTS = 3;

/**
 * Execute une transaction en isolation Serializable avec retry automatique
 * sur les conflits d'ecriture (P2034). Indispensable pour eviter les ventes
 * de stock en double lors de saisies concurrentes.
 */
export async function serializableTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 20_000,
      });
    } catch (error) {
      lastError = error;
      if (!isWriteConflict(error) || attempt === MAX_ATTEMPTS) throw error;
    }
  }

  throw lastError;
}

/** Transaction simple (lectures/ecritures non critiques). */
export async function transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn);
}

export type { PrismaClient };
