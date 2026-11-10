import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth.js';
import { parseBody, setAudit } from '../../http.js';
import { ApiError } from '../../lib/errors.js';
import { saveBuffer, saveSignature } from '../../lib/storage.js';
import { env } from '../../env.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
});

const signatureSchema = z.object({
  signatureBase64: z.string().min(50).max(5_000_000),
});

export const uploadsRouter = Router();
uploadsRouter.use(authenticate);

uploadsRouter.post('/image', upload.single('file'), async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Fichier image requis (champ "file")');
  const stored = await saveBuffer(req.file.buffer, 'receipts', req.file.mimetype);

  setAudit(res, {
    action: 'CREATE',
    entity: 'uploads',
    entityId: stored.filename,
    after: { url: stored.url, size: stored.size, mimeType: stored.mimeType },
  });

  res.status(201).json(stored);
});

uploadsRouter.post('/signature', async (req, res) => {
  const { signatureBase64 } = parseBody(signatureSchema, req);
  const stored = await saveSignature(signatureBase64);

  setAudit(res, {
    action: 'CREATE',
    entity: 'signatures',
    entityId: stored.filename,
    after: { url: stored.url, size: stored.size },
  });

  res.status(201).json(stored);
});
