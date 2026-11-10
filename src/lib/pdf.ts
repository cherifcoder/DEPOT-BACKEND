import type { Prisma } from '@prisma/client';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { formatDate, formatDateTime } from './dates.js';
import { toNumber } from './money.js';
import { readMedia } from './storage.js';

type Invoice = Prisma.SaleGetPayload<{
  include: {
    client: true;
    user: { select: { id: true; fullName: true; email: true } };
    items: { include: { product: true } };
    payments: { include: { receivedBy: { select: { id: true; fullName: true } } } };
  };
}>;

type DeliverySlip = Prisma.DeliveryGetPayload<{
  include: {
    sale: { include: { items: { include: { product: true } } } };
    client: true;
    product: true;
    livreur: true;
  };
}>;

type ClientStatement = Prisma.ClientGetPayload<{ include: { sales: { include: { payments: true } } } }>;

export interface CompanyInfo {
  storeName: string;
  address: string;
  phone: string;
  email: string;
  taxId: string | null;
  currency: string;
  invoiceFooter: string;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 42;
const GREEN = rgb(0.08, 0.33, 0.2);
const GREEN_LIGHT = rgb(0.91, 0.96, 0.92);
const GRAY = rgb(0.42, 0.45, 0.5);
const DARK = rgb(0.1, 0.12, 0.14);
const WHITE = rgb(1, 1, 1);
const RED = rgb(0.72, 0.15, 0.15);

const STATUS_LABELS: Record<string, string> = {
  EN_ATTENTE: 'Non payee',
  PARTIELLE: 'Partiellement payee',
  PAYEE: 'Payee',
  ANNULEE: 'ANNULEE',
  EN_COURS: 'En cours',
  LIVRE: 'Livree',
  ANNULE: 'Annulee',
};

function cleanText(value: string): string {
  return value
    .replaceAll('\u2019', "'")
    .replaceAll('\u2018', "'")
    .replaceAll('\u201c', '"')
    .replaceAll('\u201d', '"')
    .replaceAll('\u2013', '-')
    .replaceAll('\u2014', '-')
    .replaceAll('\u20ac', 'EUR')
    .replaceAll('\u00a0', ' ')
    .replace(/[^\x00-\xFF]/g, '?');
}

function money(value: Prisma.Decimal | number | string, currency = 'XOF'): string {
  const amount = toNumber(value as Prisma.Decimal.Value);
  return cleanText(
    `${amount.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`,
  );
}

function truncate(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const clean = cleanText(text);
  if (font.widthOfTextAtSize(clean, size) <= maxWidth) return clean;

  let result = clean;
  while (result.length > 0 && font.widthOfTextAtSize(`${result}...`, size) > maxWidth) {
    result = result.slice(0, -1);
  }
  return `${result}...`;
}

async function embedImage(doc: PDFDocument, url: string | null | undefined): Promise<PDFImage | null> {
  const buffer = await readMedia(url);
  if (!buffer || buffer.byteLength === 0) return null;

  try {
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return await doc.embedPng(buffer);
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return await doc.embedJpg(buffer);
  } catch {
    return null;
  }
  return null;
}

interface Cursor {
  page: PDFPage;
  y: number;
}

class Doc {
  readonly doc!: PDFDocument;
  readonly regular!: PDFFont;
  readonly bold!: PDFFont;
  private current!: PDFPage;
  y = 0;

  private constructor(doc: PDFDocument, regular: PDFFont, bold: PDFFont) {
    this.doc = doc;
    this.regular = regular;
    this.bold = bold;
    this.current = doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  static async create(): Promise<Doc> {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    doc.setTitle('Document');
    doc.setProducer('Depot Boissons');
    return new Doc(doc, regular, bold);
  }

  get page(): PDFPage {
    return this.current;
  }

  addPage(): void {
    this.current = this.doc.addPage(A4);
    this.y = A4[1] - MARGIN;
  }

  ensure(space: number): void {
    if (this.y - space < 70) this.addPage();
  }

  text(value: string, x: number, size = 10, options: { bold?: boolean; color?: ReturnType<typeof rgb>; maxWidth?: number } = {}): void {
    const font = options.bold ? this.bold : this.regular;
    const content = options.maxWidth ? truncate(value, font, size, options.maxWidth) : cleanText(value);
    this.page.drawText(content, { x, y: this.y, size, font, color: options.color ?? DARK });
  }

  textAt(value: string, x: number, y: number, size = 10, options: { bold?: boolean; color?: ReturnType<typeof rgb>; maxWidth?: number } = {}): void {
    const font = options.bold ? this.bold : this.regular;
    const content = options.maxWidth ? truncate(value, font, size, options.maxWidth) : cleanText(value);
    this.page.drawText(content, { x, y, size, font, color: options.color ?? DARK });
  }

  right(value: string, xRight: number, size = 10, options: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
    const font = options.bold ? this.bold : this.regular;
    const content = cleanText(value);
    const width = font.widthOfTextAtSize(content, size);
    this.page.drawText(content, { x: xRight - width, y: this.y, size, font, color: options.color ?? DARK });
  }

  rightAt(value: string, xRight: number, y: number, size = 10, options: { bold?: boolean; color?: ReturnType<typeof rgb> } = {}): void {
    const font = options.bold ? this.bold : this.regular;
    const content = cleanText(value);
    const width = font.widthOfTextAtSize(content, size);
    this.page.drawText(content, { x: xRight - width, y, size, font, color: options.color ?? DARK });
  }

  line(y = this.y, color = rgb(0.85, 0.87, 0.89)): void {
    this.page.drawLine({ start: { x: MARGIN, y }, end: { x: A4[0] - MARGIN, y }, thickness: 0.7, color });
  }

  rect(x: number, y: number, width: number, height: number, color: ReturnType<typeof rgb>): void {
    this.page.drawRectangle({ x, y, width, height, color });
  }

  addFooter(company: CompanyInfo, title: string): void {
    const pages = this.doc.getPages();
    pages.forEach((page, index) => {
      const label = cleanText(`${company.storeName} - ${title}`);
      page.drawText(label, { x: MARGIN, y: 30, size: 8, font: this.regular, color: GRAY });
      const pageLabel = `Page ${index + 1}/${pages.length}`;
      const width = this.regular.widthOfTextAtSize(pageLabel, 8);
      page.drawText(pageLabel, { x: A4[0] - MARGIN - width, y: 30, size: 8, font: this.regular, color: GRAY });
    });
  }

  async save(): Promise<Buffer> {
    const bytes = await this.doc.save();
    return Buffer.from(bytes);
  }
}

function drawHeader(doc: Doc, company: CompanyInfo, title: string, reference: string, date: string, extra?: string): void {
  doc.text(company.storeName, MARGIN, 17, { bold: true, color: GREEN });
  doc.y -= 16;
  if (company.address) {
    doc.text(company.address, MARGIN, 8.5, { color: GRAY, maxWidth: 280 });
    doc.y -= 11;
  }
  if (company.phone) {
    doc.text(`Tel : ${company.phone}`, MARGIN, 8.5, { color: GRAY });
    doc.y -= 11;
  }
  if (company.email) {
    doc.text(company.email, MARGIN, 8.5, { color: GRAY });
    doc.y -= 11;
  }
  if (company.taxId) {
    doc.text(`N° fiscal : ${company.taxId}`, MARGIN, 8.5, { color: GRAY });
  }

  const top = A4[1] - MARGIN;
  doc.textAt(title, A4[0] - MARGIN - doc.bold.widthOfTextAtSize(cleanText(title), 20), top - 4, 20, {
    bold: true,
    color: GREEN,
  });
  doc.rightAt(`N° ${reference}`, A4[0] - MARGIN, top - 24, 10, { bold: true });
  doc.rightAt(date, A4[0] - MARGIN, top - 38, 9, { color: GRAY });
  if (extra) doc.rightAt(extra, A4[0] - MARGIN, top - 52, 9, { color: GRAY });

  doc.y = top - 72;
  doc.line();
  doc.y -= 20;
}

function drawLabelValue(doc: Doc, label: string, value: string, x: number, width = 240): void {
  doc.textAt(label.toUpperCase(), x, doc.y, 7.5, { bold: true, color: GRAY });
  doc.textAt(value || '-', x, doc.y - 13, 10, { maxWidth: width });
}

function drawTableHeader(doc: Doc, columns: { label: string; x: number; width: number; align?: 'left' | 'right' }[]): void {
  const height = 22;
  doc.rect(MARGIN, doc.y - 6, A4[0] - MARGIN * 2, height, GREEN_LIGHT);
  columns.forEach((column) => {
    if (column.align === 'right') {
      const width = doc.bold.widthOfTextAtSize(column.label, 8);
      doc.textAt(column.label.toUpperCase(), column.x + column.width - width, doc.y, 8, { bold: true, color: GREEN });
    } else {
      doc.textAt(column.label.toUpperCase(), column.x, doc.y, 8, { bold: true, color: GREEN });
    }
  });
  doc.y -= 24;
}

function drawStatusBadge(doc: Doc, status: string): void {
  const label = STATUS_LABELS[status] ?? status;
  const width = doc.bold.widthOfTextAtSize(label, 8) + 14;
  doc.rect(A4[0] - MARGIN - width, doc.y - 4, width, 16, status === 'ANNULEE' ? rgb(0.99, 0.9, 0.9) : GREEN_LIGHT);
  doc.rightAt(label, A4[0] - MARGIN - 7, doc.y, 8, { bold: true, color: status === 'ANNULEE' ? RED : GREEN });
}

function drawSignature(doc: Doc, image: PDFImage | null, receiverName: string | null, caption: string): void {
  doc.ensure(130);
  const boxWidth = 220;
  const x = A4[0] - MARGIN - boxWidth;

  doc.textAt(caption, x, doc.y, 8, { bold: true, color: GRAY });
  const boxTop = doc.y - 10;
  doc.page.drawRectangle({
    x,
    y: boxTop - 80,
    width: boxWidth,
    height: 80,
    borderColor: rgb(0.8, 0.82, 0.85),
    borderWidth: 0.7,
    color: rgb(1, 1, 1),
  });

  if (image) {
    const scale = Math.min((boxWidth - 16) / image.width, 64 / image.height);
    const width = image.width * scale;
    const height = image.height * scale;
    doc.page.drawImage(image, { x: x + (boxWidth - width) / 2, y: boxTop - 8 - height, width, height });
  } else {
    doc.textAt('Signature non disponible', x + 60, boxTop - 48, 8, { color: GRAY });
  }

  if (receiverName) {
    doc.textAt(receiverName, x, boxTop - 96, 8.5, { color: GRAY, maxWidth: boxWidth });
  }
}

// ---------------------------------------------------------------------------
// FACTURE
// ---------------------------------------------------------------------------
export async function buildInvoicePdf(sale: Invoice, company: CompanyInfo): Promise<Buffer> {
  const doc = await Doc.create();
  const currency = company.currency;
  const client = sale.client;

  drawHeader(
    doc,
    company,
    sale.status === 'ANNULEE' ? 'FACTURE ANNULEE' : 'FACTURE',
    sale.reference,
    formatDate(sale.saleDate),
    `Type : ${sale.type === 'GROS' ? 'Vente en gros' : 'Vente au detail'}`,
  );

  drawStatusBadge(doc, sale.status);

  const leftX = MARGIN;
  const rightX = 320;
  drawLabelValue(doc, 'Facture a', client ? client.name : 'Client de passage', leftX, 250);
  if (client?.phone) doc.textAt(client.phone, leftX, doc.y - 26, 9, { color: GRAY, maxWidth: 250 });
  if (client?.address) doc.textAt(client.address, leftX, doc.y - 37, 9, { color: GRAY, maxWidth: 250 });

  const savedY = doc.y;
  doc.y = savedY;
  drawLabelValue(doc, 'Date de vente', formatDate(sale.saleDate), rightX, 220);
  doc.textAt(`Echeance : ${sale.dueDate ? formatDate(sale.dueDate) : '-'}`, rightX, doc.y - 26, 9, { color: GRAY });
  doc.textAt(`Vendeur : ${sale.user.fullName}`, rightX, doc.y - 37, 9, { color: GRAY, maxWidth: 220 });
  doc.y = savedY - 54;

  const cols = [
    { label: 'Designation', x: MARGIN + 4, width: 250 },
    { label: 'Qte', x: 310, width: 40, align: 'right' as const },
    { label: 'Prix unit.', x: 360, width: 80, align: 'right' as const },
    { label: 'Total', x: 450, width: 100, align: 'right' as const },
  ];
  drawTableHeader(doc, cols);

  for (const item of sale.items) {
    doc.ensure(26);
    const label = `${item.product.name}${item.product.volumeCl ? ` ${item.product.volumeCl}cl` : ''}`;
    doc.textAt(label, cols[0]!.x, doc.y, 9, { maxWidth: cols[0]!.width });
    doc.rightAt(String(item.quantity), cols[1]!.x + cols[1]!.width, doc.y, 9);
    doc.rightAt(money(item.unitPrice, currency), cols[2]!.x + cols[2]!.width, doc.y, 9);
    doc.rightAt(money(item.lineTotal, currency), cols[3]!.x + cols[3]!.width, doc.y, 9);
    doc.y -= 8;
    doc.line();
    doc.y -= 12;
  }

  doc.y -= 4;
  const totalsX = 330;
  const totalsWidth = 220;
  const totalLine = (label: string, value: string, bold = false) => {
    doc.textAt(label, totalsX, doc.y, 9, { color: bold ? DARK : GRAY, bold });
    doc.rightAt(value, totalsX + totalsWidth, doc.y, 9, { bold });
    doc.y -= 15;
  };

  totalLine('Sous-total', money(sale.subtotal, currency));
  if (toNumber(sale.discount) > 0) totalLine('Remise', `- ${money(sale.discount, currency)}`);
  totalLine('TOTAL', money(sale.totalAmount, currency), true);
  totalLine('Deja paye', money(sale.paidAmount, currency));
  doc.y -= 2;
  doc.line(doc.y + 12);
  doc.y -= 2;
  totalLine('RESTE A PAYER', money(sale.balanceDue, currency), true);

  if (sale.payments.length > 0) {
    doc.ensure(80);
    doc.y -= 10;
    doc.text('Historique des paiements', MARGIN, 10, { bold: true, color: GREEN });
    doc.y -= 14;
    for (const payment of sale.payments) {
      doc.ensure(16);
      const label = `${formatDate(payment.paidAt)} - ${payment.method}${payment.reference ? ` (${payment.reference})` : ''}${payment.receivedBy?.fullName ? ` - Encaisse par ${payment.receivedBy.fullName}` : ''}`;
      doc.textAt(label, MARGIN, doc.y, 8.5, { maxWidth: 350, color: GRAY });
      doc.rightAt(money(payment.amount, currency), 380, doc.y, 8.5);
      doc.y -= 13;
    }
  }

  if (sale.status === 'ANNULEE' && sale.cancelReason) {
    doc.ensure(30);
    doc.text(`Motif d'annulation : ${sale.cancelReason}`, MARGIN, 9, { color: RED, maxWidth: 500 });
    doc.y -= 15;
  }

  const signature = await embedImage(doc.doc, sale.signatureUrl);
  drawSignature(doc, signature, client?.name ?? null, 'Signature du client');

  doc.ensure(40);
  doc.textAt(company.invoiceFooter, MARGIN, 56, 8, { color: GRAY, maxWidth: 500 });
  doc.addFooter(company, 'Facture');
  return doc.save();
}

// ---------------------------------------------------------------------------
// BON DE LIVRAISON
// ---------------------------------------------------------------------------
export async function buildDeliverySlipPdf(delivery: DeliverySlip, company: CompanyInfo): Promise<Buffer> {
  const doc = await Doc.create();
  const currency = company.currency;

  drawHeader(
    doc,
    company,
    'BON DE LIVRAISON',
    delivery.reference,
    formatDate(delivery.createdAt),
    `Statut : ${STATUS_LABELS[delivery.status] ?? delivery.status}`,
  );

  const leftX = MARGIN;
  const rightX = 320;
  drawLabelValue(doc, 'Destinataire', delivery.client?.name ?? delivery.receiverName ?? '-', leftX, 250);
  doc.textAt(delivery.destination, leftX, doc.y - 26, 9, { color: GRAY, maxWidth: 250 });
  if (delivery.client?.phone) doc.textAt(delivery.client.phone, leftX, doc.y - 37, 9, { color: GRAY });

  const savedY = doc.y;
  drawLabelValue(doc, 'Livreur', delivery.livreur.fullName, rightX, 220);
  doc.textAt(`Vente : ${delivery.sale?.reference ?? '-'}`, rightX, doc.y - 26, 9, { color: GRAY });
  doc.textAt(
    `Prevue : ${delivery.scheduledAt ? formatDateTime(delivery.scheduledAt) : '-'}`,
    rightX,
    doc.y - 37,
    9,
    { color: GRAY },
  );
  doc.textAt(
    `Livree : ${delivery.deliveredAt ? formatDateTime(delivery.deliveredAt) : '-'}`,
    rightX,
    doc.y - 48,
    9,
    { color: GRAY },
  );
  doc.y = savedY - 64;

  const cols = [
    { label: 'Produit', x: MARGIN + 4, width: 330 },
    { label: 'Quantite', x: 420, width: 130, align: 'right' as const },
  ];
  drawTableHeader(doc, cols);

  type Row = { name: string; quantity: number };
  const rows: Row[] = delivery.sale
    ? delivery.sale.items.map((item) => ({
        name: `${item.product.name}${item.product.volumeCl ? ` ${item.product.volumeCl}cl` : ''}`,
        quantity: item.quantity,
      }))
    : delivery.product
      ? [{ name: delivery.product.name, quantity: delivery.quantity ?? 0 }]
      : [];

  rows.forEach((row) => {
    doc.ensure(26);
    doc.textAt(row.name, cols[0]!.x, doc.y, 9, { maxWidth: cols[0]!.width });
    doc.rightAt(String(row.quantity), cols[1]!.x + cols[1]!.width, doc.y, 9);
    doc.y -= 8;
    doc.line();
    doc.y -= 12;
  });

  if (delivery.sale) {
    doc.y -= 4;
    const outstanding = money(delivery.sale.balanceDue, currency);
    doc.textAt('Reste a payer sur la vente', MARGIN, doc.y, 9, { color: GRAY });
    doc.rightAt(outstanding, A4[0] - MARGIN, doc.y, 10, { bold: true });
    doc.y -= 22;
  }

  if (delivery.notes) {
    doc.textAt(`Observations : ${delivery.notes}`, MARGIN, doc.y, 8.5, { color: GRAY, maxWidth: 500 });
    doc.y -= 20;
  }

  doc.text('Decharge du destinataire', MARGIN, 10, { bold: true, color: GREEN });
  doc.y -= 13;
  doc.text('Je reconnais avoir recu les produits listes ci-dessus en bon etat.', MARGIN, 8.5, {
    color: GRAY,
    maxWidth: 300,
  });
  const signature = await embedImage(doc.doc, delivery.signatureUrl);
  drawSignature(doc, signature, delivery.receiverName, 'Signature du receptionnaire');

  const proof = await embedImage(doc.doc, delivery.photoProofUrl);
  if (proof) {
    doc.ensure(190);
    doc.y -= 10;
    doc.text('Preuve visuelle de livraison', MARGIN, 10, { bold: true, color: GREEN });
    doc.y -= 12;
    const maxWidth = 240;
    const maxHeight = 150;
    const scale = Math.min(maxWidth / proof.width, maxHeight / proof.height);
    doc.page.drawImage(proof, {
      x: MARGIN,
      y: doc.y - proof.height * scale,
      width: proof.width * scale,
      height: proof.height * scale,
    });
    doc.y -= proof.height * scale + 12;
  }

  doc.addFooter(company, 'Bon de livraison');
  return doc.save();
}

// ---------------------------------------------------------------------------
// RELEVE DE COMPTE CLIENT
// ---------------------------------------------------------------------------
export async function buildClientStatementPdf(
  client: ClientStatement,
  company: CompanyInfo,
  range: { from: Date; to: Date },
): Promise<Buffer> {
  const doc = await Doc.create();
  const currency = company.currency;

  drawHeader(
    doc,
    company,
    'RELEVE DE COMPTE',
    client.id.slice(0, 8).toUpperCase(),
    `Du ${formatDate(range.from)} au ${formatDate(range.to)}`,
  );

  drawLabelValue(doc, 'Client', client.name, MARGIN, 260);
  if (client.phone) doc.textAt(client.phone, MARGIN, doc.y - 26, 9, { color: GRAY });
  if (client.address) doc.textAt(client.address, MARGIN, doc.y - 37, 9, { color: GRAY, maxWidth: 260 });
  doc.y -= 58;

  const cols = [
    { label: 'Date', x: MARGIN + 4, width: 62 },
    { label: 'Reference', x: 116, width: 110 },
    { label: 'Total', x: 240, width: 80, align: 'right' as const },
    { label: 'Paye', x: 330, width: 80, align: 'right' as const },
    { label: 'Solde', x: 420, width: 90, align: 'right' as const },
  ];
  drawTableHeader(doc, cols);

  let total = 0;
  let paid = 0;

  client.sales.forEach((sale) => {
    doc.ensure(24);
    const rowY = doc.y;
    doc.textAt(formatDate(sale.saleDate), cols[0]!.x, rowY, 8.5);
    doc.textAt(sale.reference, cols[1]!.x, rowY, 8.5, { maxWidth: cols[1]!.width });
    doc.rightAt(money(sale.totalAmount, currency), cols[2]!.x + cols[2]!.width, rowY, 8.5);
    doc.rightAt(money(sale.paidAmount, currency), cols[3]!.x + cols[3]!.width, rowY, 8.5);
    doc.rightAt(money(sale.balanceDue, currency), cols[4]!.x + cols[4]!.width, rowY, 8.5);
    total += toNumber(sale.totalAmount);
    paid += toNumber(sale.paidAmount);
    doc.y -= 8;
    doc.line();
    doc.y -= 12;
  });

  doc.y -= 6;
  doc.textAt('TOTAL', 240, doc.y, 9, { bold: true });
  doc.rightAt(money(total, currency), 320, doc.y, 9, { bold: true });
  doc.rightAt(money(paid, currency), 410, doc.y, 9, { bold: true });
  doc.rightAt(money(total - paid, currency), 510, doc.y, 9, { bold: true, color: RED });
  doc.y -= 24;

  if (client.creditLimit && toNumber(client.creditLimit) > 0) {
    doc.textAt(`Plafond de credit : ${money(client.creditLimit, currency)}`, MARGIN, doc.y, 9, { color: GRAY });
    doc.y -= 14;
  }

  doc.addFooter(company, 'Releve de compte');
  return doc.save();
}
