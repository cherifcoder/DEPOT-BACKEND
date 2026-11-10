import 'dotenv/config';
import { z } from 'zod';

const booleanFromString = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(defaultValue)
    .transform((value) => value === 'true');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL est requis'),

  PUBLIC_BASE_URL: z.url().default('http://localhost:4000'),
  CORS_ORIGINS: z.string().default('*'),
  UPLOAD_DIR: z.string().default('./uploads'),
  MAX_UPLOAD_MB: z.coerce.number().positive().default(10),

  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET doit contenir au moins 16 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET doit contenir au moins 16 caracteres'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  EXPO_ACCESS_TOKEN: z.string().optional().default(''),
  ENABLE_CRON: booleanFromString('true'),
  CRON_TIMEZONE: z.string().default('Africa/Abidjan'),

  LOG_LEVEL: z.string().default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const details = parsed.error.issues
    .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  console.error(`Configuration invalide (.env) :\n${details}`);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  corsOrigins:
    parsed.data.CORS_ORIGINS === '*'
      ? true
      : parsed.data.CORS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean),
};

export type Env = typeof env;
