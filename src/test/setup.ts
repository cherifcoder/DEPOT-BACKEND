process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://depot:depot@localhost:5432/depot_boissons_test?schema=public';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789';
process.env.ENABLE_CRON = 'false';
process.env.UPLOAD_DIR = './.test-uploads';
process.env.LOG_LEVEL = 'silent';
