import { PrismaClient } from '@prisma/client';
import { env } from '../env.js';

export const prisma = new PrismaClient({
  log: env.isProduction ? ['error'] : ['warn', 'error'],
});

export type DbClient = typeof prisma;
