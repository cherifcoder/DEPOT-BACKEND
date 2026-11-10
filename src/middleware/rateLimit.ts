import rateLimit from 'express-rate-limit';
import { env } from '../env.js';

const skip = () => env.isTest;

export const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 400,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de requetes, ralentissez.' } },
});

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  skip,
  message: {
    error: { code: 'TOO_MANY_ATTEMPTS', message: 'Trop de tentatives de connexion. Reessayez dans 15 minutes.' },
  },
});

export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skip,
  message: { error: { code: 'TOO_MANY_REQUESTS', message: 'Trop de televersements.' } },
});
