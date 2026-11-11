/**
 * Initialisation de production : cree le compte administrateur unique et les
 * reglages du depot (identite affichee sur les factures, bons de livraison et
 * releves). Idempotent : peut etre relance sans risque.
 *
 *   npm run db:bootstrap
 *
 * Remise a zero complete d'une base de production :
 *   npm run db:reset && npm run db:bootstrap
 *
 * Variables optionnelles : ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULL_NAME,
 * LOGO_URL (logo servi par l'API : /logo.png).
 */
import { prisma } from '../src/lib/prisma.js';
import { hashPassword } from '../src/lib/password.js';

const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? 'admin@depot.app').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Admin@2026!';
const ADMIN_FULL_NAME = process.env.ADMIN_FULL_NAME ?? 'Administrateur';
const LOGO_URL = process.env.LOGO_URL ?? 'https://depotbackend.vercel.app/logo.png';

const SETTINGS = {
  id: 'default',
  storeName: 'Dépôt HAIDARA',
  address: 'Près de la SONATAM',
  phone: '75191786',
  email: '',
  taxId: null,
  currency: 'XOF',
  logoUrl: LOGO_URL,
  invoiceFooter: 'Merci de votre confiance. Les marchandises vendues ne sont ni reprises ni échangées après 48h.',
  lowStockAlerts: true,
};

async function main() {
  console.log('Initialisation de production...');

  const { id, ...values } = SETTINGS;
  await prisma.systemSetting.upsert({
    where: { id },
    update: values,
    create: SETTINGS,
  });
  console.log(`Reglages du depot : ${SETTINGS.storeName} / ${SETTINGS.address} / Tel ${SETTINGS.phone}`);

  const existing = await prisma.user.findUnique({ where: { email: ADMIN_EMAIL } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: { fullName: ADMIN_FULL_NAME, isActive: true, mustChangePassword: false, deletedAt: null },
    });
    await prisma.userRole.deleteMany({ where: { userId: existing.id } });
    await prisma.userRole.createMany({ data: [{ userId: existing.id, role: 'ADMIN' }] });
    console.log(`Administrateur mis a jour : ${ADMIN_EMAIL}`);
  } else {
    const user = await prisma.user.create({
      data: {
        fullName: ADMIN_FULL_NAME,
        email: ADMIN_EMAIL,
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        isActive: true,
        mustChangePassword: false,
      },
    });
    await prisma.userRole.createMany({ data: [{ userId: user.id, role: 'ADMIN' }] });
    console.log(`Administrateur cree : ${ADMIN_EMAIL}`);
  }
}

main()
  .catch((error) => {
    console.error("Echec de l'initialisation :", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
