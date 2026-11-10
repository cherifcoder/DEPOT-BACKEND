import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit } from '../../http.js';
import { buildExcel } from '../../lib/excel.js';
import { saveBuffer } from '../../lib/storage.js';
import { env } from '../../env.js';
import { updateLogo } from '../settings/setting.service.js';
import {
  addPayment,
  addPaymentSchema,
  cancelSale,
  cancelSaleSchema,
  createSale,
  createSaleSchema,
  getInvoicePdf,
  getSale,
  getSaleSummary,
  listSales,
  saleListQuerySchema,
  signSale,
  signSaleSchema,
} from './sale.service.js';
import { requireRoles } from '../../middleware/auth.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
});

export const salesRouter = Router();
salesRouter.use(authenticate);

salesRouter.get('/', async (req, res) => {
  res.json(await listSales(parseQuery(saleListQuerySchema, req)));
});

salesRouter.post('/', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const actor = requireUser(req);
  const input = parseBody(createSaleSchema, req);
  const { sale, created } = await createSale(input, actor.id);

  setAudit(res, {
    action: 'CREATE',
    entity: 'sales',
    entityId: sale.id,
    after: {
      reference: sale.reference,
      client: sale.client?.name ?? null,
      type: sale.type,
      totalAmount: sale.totalAmount,
      paidAmount: sale.paidAmount,
      balanceDue: sale.balanceDue,
      items: sale.items.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: item.unitPrice })),
    },
    metadata: { idempotentReplay: !created },
  });

  res.status(created ? 201 : 200).json({ sale, created });
});

salesRouter.get('/:id', async (req, res) => {
  res.json(await getSale(idParam(req)));
});

salesRouter.get('/:id/summary', async (req, res) => {
  res.json(await getSaleSummary(idParam(req)));
});

salesRouter.get('/:id/invoice.pdf', async (req, res) => {
  const pdf = await getInvoicePdf(idParam(req));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="facture-${idParam(req)}.pdf"`);
  res.send(pdf);
});

salesRouter.get('/:id/invoice.xlsx', async (req, res) => {
  const sale = await getSale(idParam(req));

  const buffer = await buildExcel([
    {
      name: 'Facture',
      title: `Facture ${sale.reference}`,
      subtitle: `Client : ${sale.client?.name ?? 'Client de passage'} | Date : ${sale.saleDate.toLocaleDateString('fr-FR')} | Vendeur : ${sale.user.fullName}`,
      columns: [
        { header: 'Designation', key: 'designation', width: 40 },
        { header: 'Quantite', key: 'quantity', width: 12, type: 'number' },
        { header: 'Prix unitaire', key: 'unitPrice', width: 16, type: 'money' },
        { header: 'Total ligne', key: 'lineTotal', width: 16, type: 'money' },
      ],
      rows: sale.items.map((item) => ({
        designation: item.product.name,
        quantity: item.quantity,
        unitPrice: Number(item.unitPrice),
        lineTotal: Number(item.lineTotal),
      })),
      totals: { lineTotal: Number(sale.totalAmount) },
    },
  ]);

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="facture-${sale.reference}.xlsx"`);
  res.send(buffer);
});

salesRouter.post('/:id/payments', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const actor = requireUser(req);
  const before = await getSale(id);
  const result = await addPayment(id, parseBody(addPaymentSchema, req), actor.id);

  setAudit(res, {
    action: 'CREATE',
    entity: 'payments',
    entityId: result.payment.id,
    before: { saleId: id, balanceDue: before.balanceDue },
    after: { saleId: id, balanceDue: result.sale.balanceDue, amount: result.payment.amount, method: result.payment.method },
    metadata: { operation: 'encaissement', saleReference: result.sale.reference },
  });

  res.status(result.created ? 201 : 200).json(result);
});

salesRouter.post('/:id/cancel', requireAdmin(), async (req, res) => {
  const id = idParam(req);
  const before = await getSale(id);
  const sale = await cancelSale(id, parseBody(cancelSaleSchema, req).reason);

  setAudit(res, {
    action: 'EXECUTE',
    entity: 'sales',
    entityId: id,
    before: { status: before.status, balanceDue: before.balanceDue },
    after: { status: sale.status, balanceDue: sale.balanceDue },
    metadata: { operation: 'cancel_sale', reason: sale.cancelReason },
  });

  res.json(sale);
});

salesRouter.post('/:id/signature', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const sale = await signSale(id, parseBody(signSaleSchema, req).signatureBase64);
  setAudit(res, {
    action: 'UPDATE',
    entity: 'sales',
    entityId: id,
    after: { signatureUrl: sale.signatureUrl, signedAt: sale.signedAt },
    metadata: { operation: 'electronic_signature' },
  });
  res.json(sale);
});

salesRouter.post('/:id/attachment', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Fichier requis' } });
    return;
  }
  const stored = await saveBuffer(req.file.buffer, 'receipts', req.file.mimetype);
  res.json(stored);
});
