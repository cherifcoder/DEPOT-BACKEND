import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type { Role } from '@prisma/client';
import { authenticate, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit, setAuditEntity } from '../../http.js';
import { ApiError } from '../../lib/errors.js';
import { env } from '../../env.js';
import {
  assignDelivery,
  assignDeliverySchema,
  completeDeliveryWithProof,
  createDelivery,
  createDeliverySchema,
  deliveryListQuerySchema,
  deliveryStats,
  getDelivery,
  getDeliverySlipPdf,
  listDeliveries,
  listLivreurs,
  saveDeliveryPhoto,
  updateDeliveryStatus,
  updateDeliveryStatusSchema,
} from './delivery.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
});

const proofBodySchema = z.object({
  receiverName: z.string().trim().min(2, 'Nom du receptionnaire requis').max(150),
  signatureBase64: z.string().max(5_000_000).optional(),
  notes: z.string().trim().max(1000).optional(),
});

export const deliveriesRouter = Router();
deliveriesRouter.use(authenticate);

/** Un utilisateur uniquement LIVREUR ne peut agir que sur ses propres livraisons. */
function isDriverOnly(user: { roles: Role[] }): boolean {
  return (
    user.roles.includes('LIVREUR') &&
    !user.roles.some((role) => role === 'ADMIN' || role === 'VENDEUR' || role === 'COMPTABLE')
  );
}

function assertDeliveryAccess(
  user: { id: string; roles: Role[] },
  delivery: { livreurId: string },
): void {
  if (isDriverOnly(user) && delivery.livreurId !== user.id) {
    throw ApiError.forbidden('Cette livraison est affectee a un autre livreur');
  }
}

deliveriesRouter.get('/', async (req, res) => {
  const actor = requireUser(req);
  const query = parseQuery(deliveryListQuerySchema, req);
  if (isDriverOnly(actor) && !query.mine) query.mine = 'true';
  res.json(await listDeliveries(query, actor.id));
});

deliveriesRouter.get('/stats', async (req, res) => {
  res.json(await deliveryStats(req.query as Record<string, string>));
});

deliveriesRouter.get('/livreurs', async (_req, res) => {
  res.json({ data: await listLivreurs() });
});

deliveriesRouter.get('/:id', async (req, res) => {
  const actor = requireUser(req);
  const delivery = await getDelivery(idParam(req));
  assertDeliveryAccess(actor, delivery);
  res.json(delivery);
});

deliveriesRouter.get('/:id/slip.pdf', async (req, res) => {
  const actor = requireUser(req);
  const delivery = await getDelivery(idParam(req));
  assertDeliveryAccess(actor, delivery);

  const pdf = await getDeliverySlipPdf(delivery.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="bon-livraison.pdf"');
  res.send(pdf);
});

deliveriesRouter.post('/', requireRoles('VENDEUR', 'COMPTABLE', 'LIVREUR'), async (req, res) => {
  const actor = requireUser(req);
  const input = parseBody(createDeliverySchema, req);
  if (isDriverOnly(actor)) input.livreurId = actor.id;

  const { delivery, created } = await createDelivery(input, actor.id);
  setAuditEntity(res, delivery.id);
  setAudit(res, {
    action: 'CREATE',
    entity: 'deliveries',
    entityId: delivery.id,
    after: {
      reference: delivery.reference,
      destination: delivery.destination,
      livreur: delivery.livreur.fullName,
      saleReference: delivery.sale?.reference ?? null,
    },
    metadata: { idempotentReplay: !created },
  });
  res.status(created ? 201 : 200).json({ delivery, created });
});

deliveriesRouter.patch('/:id/status', requireRoles('LIVREUR', 'VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const actor = requireUser(req);
  const before = await getDelivery(id);
  assertDeliveryAccess(actor, before);
  const delivery = await updateDeliveryStatus(id, parseBody(updateDeliveryStatusSchema, req));
  setAudit(res, {
    action: 'UPDATE',
    entity: 'deliveries',
    entityId: id,
    before: { status: before.status },
    after: { status: delivery.status, receiverName: delivery.receiverName, deliveredAt: delivery.deliveredAt },
    metadata: { operation: 'delivery_status' },
  });
  res.json(delivery);
});

deliveriesRouter.patch('/:id/assign', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const before = await getDelivery(id);
  const delivery = await assignDelivery(id, parseBody(assignDeliverySchema, req).livreurId);
  setAudit(res, {
    action: 'UPDATE',
    entity: 'deliveries',
    entityId: id,
    before: { livreur: before.livreur.fullName },
    after: { livreur: delivery.livreur.fullName },
    metadata: { operation: 'reassign_driver' },
  });
  res.json(delivery);
});

/**
 * Preuve de livraison : multipart (photo) + champs receiverName, signatureBase64, notes.
 * Valide automatiquement la livraison et horodate la decharge.
 */
deliveriesRouter.post(
  '/:id/proof',
  requireRoles('LIVREUR', 'VENDEUR', 'COMPTABLE'),
  upload.single('photo'),
  async (req, res) => {
    const id = idParam(req);
    const actor = requireUser(req);
    const before = await getDelivery(id);
    assertDeliveryAccess(actor, before);
    const input = proofBodySchema.parse(req.body);

    let photoProofUrl: string | undefined;
    if (req.file) {
      const stored = await saveDeliveryPhoto(req.file);
      photoProofUrl = stored.url;
    }

    if (!input.signatureBase64 && !photoProofUrl) {
      throw ApiError.badRequest('Ajoutez la signature du receptionnaire (et idealement une photo de preuve)');
    }

    const delivery = await completeDeliveryWithProof(id, {
      receiverName: input.receiverName,
      signatureBase64: input.signatureBase64,
      photoProofUrl,
      notes: input.notes,
    });

    setAudit(res, {
      action: 'EXECUTE',
      entity: 'deliveries',
      entityId: id,
      after: {
        status: delivery.status,
        receiverName: delivery.receiverName,
        signatureUrl: delivery.signatureUrl,
        photoProofUrl: delivery.photoProofUrl,
        deliveredAt: delivery.deliveredAt,
      },
      metadata: { operation: 'proof_of_delivery' },
    });

    res.json(delivery);
  },
);
