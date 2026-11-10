import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { parseBody, setAudit } from '../../http.js';
import { ApiError } from '../../lib/errors.js';
import { saveBuffer } from '../../lib/storage.js';
import { env } from '../../env.js';
import { getSettings, settingsUpdateSchema, updateLogo, updateSettings } from './setting.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
});

export const settingsRouter = Router();
settingsRouter.use(authenticate);

settingsRouter.get('/', async (_req, res) => {
  res.json(await getSettings());
});

settingsRouter.put('/', requireAdmin(), async (req, res) => {
  const before = await getSettings();
  const settings = await updateSettings(parseBody(settingsUpdateSchema, req));

  setAudit(res, {
    action: 'UPDATE',
    entity: 'settings',
    entityId: settings.id,
    before: { storeName: before.storeName, currency: before.currency, lowStockAlerts: before.lowStockAlerts },
    after: { storeName: settings.storeName, currency: settings.currency, lowStockAlerts: settings.lowStockAlerts },
  });

  res.json(settings);
});

settingsRouter.post('/logo', requireAdmin(), upload.single('file'), async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Fichier image requis (champ "file")');

  const stored = await saveBuffer(req.file.buffer, 'settings', req.file.mimetype);
  const settings = await updateLogo(stored.url);

  setAudit(res, {
    action: 'UPDATE',
    entity: 'settings',
    entityId: settings.id,
    after: { logoUrl: stored.url },
  });

  res.json(settings);
});
