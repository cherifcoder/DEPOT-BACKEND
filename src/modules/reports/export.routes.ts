import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { EXPORT_ENTITIES, buildExport, type ExportEntity } from './export.service.js';
import { ApiError } from '../../lib/errors.js';

const paramsSchema = z.object({
  entity: z.enum(EXPORT_ENTITIES),
});

export const exportsRouter = Router();
exportsRouter.use(authenticate, requireAdmin());

exportsRouter.get('/:entity.xlsx', async (req, res) => {
  const raw = req.params.entity;
  if (!raw) throw ApiError.badRequest('Entite d export requise');

  const parsed = paramsSchema.safeParse({ entity: raw });
  if (!parsed.success) throw ApiError.badRequest(`Entite inconnue. Valeurs possibles : ${EXPORT_ENTITIES.join(', ')}`);

  const { buffer, filename } = await buildExport(parsed.data.entity as ExportEntity, req.query as Record<string, string>);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.byteLength));
  res.send(buffer);
});
