import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireAdmin, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit, setAuditEntity } from '../../http.js';
import { ApiError } from '../../lib/errors.js';
import { saveBuffer } from '../../lib/storage.js';
import { env } from '../../env.js';
import {
  adjustStock,
  adjustStockSchema,
  archiveProduct,
  createCategory,
  createProduct,
  createProductSchema,
  deleteCategory,
  getProduct,
  listCategories,
  listProductMovements,
  listProducts,
  productCategorySchema,
  productListQuerySchema,
  updateCategory,
  updateProduct,
  updateProductSchema,
} from './product.service.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
});

export const productsRouter = Router();
productsRouter.use(authenticate);

// ---------------------------------------------------------------- Categories
productsRouter.get('/categories', async (_req, res) => {
  res.json({ data: await listCategories() });
});

productsRouter.post('/categories', requireAdmin(), async (req, res) => {
  const category = await createCategory(parseBody(productCategorySchema, req));
  setAuditEntity(res, category.id);
  res.status(201).json(category);
});

productsRouter.patch('/categories/:id', requireAdmin(), async (req, res) => {
  const id = idParam(req);
  const category = await updateCategory(id, parseBody(productCategorySchema, req));
  setAudit(res, { action: 'UPDATE', entity: 'product_categories', entityId: id, after: category });
  res.json(category);
});

productsRouter.delete('/categories/:id', requireAdmin(), async (req, res) => {
  const id = idParam(req);
  await deleteCategory(id);
  setAudit(res, { action: 'DELETE', entity: 'product_categories', entityId: id });
  res.status(204).send();
});

// -------------------------------------------------------------------- Produits
productsRouter.get('/', async (req, res) => {
  res.json(await listProducts(parseQuery(productListQuerySchema, req)));
});

productsRouter.get('/:id', async (req, res) => {
  res.json(await getProduct(idParam(req)));
});

productsRouter.get('/:id/movements', async (req, res) => {
  const page = Number(req.query.page ?? 1);
  const limit = Math.min(Number(req.query.limit ?? 30), 100);
  res.json(await listProductMovements(idParam(req), Number.isFinite(page) && page > 0 ? page : 1, limit));
});

productsRouter.post('/', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const actor = requireUser(req);
  const product = await createProduct(parseBody(createProductSchema, req), actor.id);
  setAuditEntity(res, product.id);
  setAudit(res, {
    action: 'CREATE',
    entity: 'products',
    entityId: product.id,
    after: { sku: product.sku, name: product.name, stockQty: product.stockQty, prices: product.salePriceDetail },
  });
  res.status(201).json(product);
});

productsRouter.patch('/:id', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const before = await getProduct(id);
  const product = await updateProduct(id, parseBody(updateProductSchema, req));
  setAudit(res, {
    action: 'UPDATE',
    entity: 'products',
    entityId: id,
    before: { name: before.name, costPrice: before.costPrice, salePriceGros: before.salePriceGros, salePriceDetail: before.salePriceDetail },
    after: { name: product.name, costPrice: product.costPrice, salePriceGros: product.salePriceGros, salePriceDetail: product.salePriceDetail },
  });
  res.json(product);
});

productsRouter.delete('/:id', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const before = await getProduct(id);
  await archiveProduct(id);
  setAudit(res, {
    action: 'DELETE',
    entity: 'products',
    entityId: id,
    before: { sku: before.sku, name: before.name },
  });
  res.status(204).send();
});

productsRouter.post('/:id/image', upload.single('file'), async (req, res) => {
  const id = idParam(req);
  await getProduct(id);

  if (!req.file) throw ApiError.badRequest('Fichier image requis (champ "file")');

  const stored = await saveBuffer(req.file.buffer, 'products', req.file.mimetype);
  const product = await updateProduct(id, { imageUrl: stored.url });

  setAudit(res, {
    action: 'UPDATE',
    entity: 'products',
    entityId: id,
    after: { imageUrl: stored.url },
  });

  res.json({ product, image: stored });
});

productsRouter.post('/:id/adjust-stock', requireAdmin(), async (req, res) => {
  const id = idParam(req);
  const actor = requireUser(req);
  const before = await getProduct(id);
  const product = await adjustStock(id, parseBody(adjustStockSchema, req), actor.id);

  setAudit(res, {
    action: 'UPDATE',
    entity: 'products',
    entityId: id,
    before: { stockQty: before.stockQty },
    after: { stockQty: product.stockQty },
    metadata: { operation: 'adjust_stock' },
  });

  res.json(product);
});
