/**
 * Demarre une instance PostgreSQL 16 locale et portable pour le developpement.
 * Aucun service systeme ni Docker n'est necessaire : les binaires viennent du
 * paquet `embedded-postgres` et les donnees sont stockees dans `apps/api/.pgdata`.
 *
 * Identifiants alignes sur DATABASE_URL de `apps/api/.env` :
 * postgresql://depot:depot@localhost:5432/depot_boissons
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const DATABASE = process.env.LOCAL_DB_NAME ?? 'depot_boissons';
const USER = process.env.LOCAL_DB_USER ?? 'depot';
const PASSWORD = process.env.LOCAL_DB_PASSWORD ?? 'depot';
const PORT = Number(process.env.LOCAL_DB_PORT ?? 5432);

const dataDir = path.resolve(import.meta.dirname, '..', '.pgdata');

const postgres = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  autoRehydrateSymlinks: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: (message) => console.log(`[postgres] ${message}`),
  onError: (error) => console.error('[postgres]', error),
});

/** PostgreSQL refuse de demarrer avec un jeton administrateur sous Windows. */
function isElevatedOnWindows(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    execFileSync('net', ['session'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise((resolve) => {
    const keepAlive = setInterval(() => undefined, 60_000);
    const stop = () => {
      clearInterval(keepAlive);
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function main(): Promise<void> {
  if (isElevatedOnWindows()) {
    console.error('PostgreSQL refuse de demarrer depuis un terminal administrateur.');
    console.error('Ouvrez un PowerShell normal (sans "Executer en tant qu administrateur") puis relancez :');
    console.error('  npm run db:local');
    process.exitCode = 1;
    return;
  }

  const firstRun = !existsSync(path.join(dataDir, 'PG_VERSION'));

  if (firstRun) {
    console.log(`Initialisation du cluster PostgreSQL dans ${dataDir}...`);
    await postgres.initialise();
  }

  await postgres.start();

  const client = postgres.getPgClient('postgres');
  await client.connect();
  try {
    const existing = await client.query('select 1 from pg_database where datname = $1', [DATABASE]);
    if (existing.rowCount === 0) {
      await postgres.createDatabase(DATABASE);
      console.log(`Base "${DATABASE}" creee.`);
    }
  } finally {
    await client.end();
  }

  console.log(`PostgreSQL pret : postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`);
  console.log('Laissez ce terminal ouvert. Ctrl+C pour arreter la base.');

  await waitForShutdown();

  console.log('Arret de PostgreSQL...');
  await postgres.stop();
}

main().catch(async (error) => {
  console.error('Impossible de demarrer PostgreSQL :', error instanceof Error ? error.message : error);
  await postgres.stop().catch(() => undefined);
  process.exitCode = 1;
});
