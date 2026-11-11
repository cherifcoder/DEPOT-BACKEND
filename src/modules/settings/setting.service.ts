import { z } from 'zod';
import { prisma } from '../../lib/prisma.js';
import type { CompanyInfo } from '../../lib/pdf.js';

export const settingsUpdateSchema = z.object({
  storeName: z.string().trim().min(2).max(120).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(40).optional(),
  email: z.email().optional().or(z.literal('')),
  logoUrl: z.string().trim().max(500).optional().nullable(),
  taxId: z.string().trim().max(80).optional().nullable(),
  currency: z.string().trim().min(1).max(10).optional(),
  invoiceFooter: z.string().trim().max(300).optional(),
  lowStockAlerts: z.boolean().optional(),
});

const DEFAULT_SETTINGS_ID = 'default';

async function ensureSettings() {
  return prisma.systemSetting.upsert({
    where: { id: DEFAULT_SETTINGS_ID },
    update: {},
    create: { id: DEFAULT_SETTINGS_ID },
  });
}

export async function getSettings() {
  return ensureSettings();
}

export async function getCompanyInfo(): Promise<CompanyInfo> {
  const settings = await ensureSettings();
  return {
    storeName: settings.storeName,
    address: settings.address,
    phone: settings.phone,
    email: settings.email,
    taxId: settings.taxId,
    currency: settings.currency,
    invoiceFooter: settings.invoiceFooter,
    logoUrl: settings.logoUrl,
  };
}

export async function updateSettings(input: z.infer<typeof settingsUpdateSchema>) {
  await ensureSettings();
  return prisma.systemSetting.update({
    where: { id: DEFAULT_SETTINGS_ID },
    data: { ...input, email: input.email ?? undefined },
  });
}

export async function updateLogo(logoUrl: string) {
  await ensureSettings();
  return prisma.systemSetting.update({ where: { id: DEFAULT_SETTINGS_ID }, data: { logoUrl } });
}
