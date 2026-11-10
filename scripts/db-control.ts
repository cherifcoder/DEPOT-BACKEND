/**
 * Controle le PostgreSQL local du projet.
 *
 * Contrairement a `db:local` (qui garde un terminal ouvert), cette commande
 * demarre PostgreSQL en processus detache : la base continue de tourner meme
 * si le terminal ou l'agent qui l'a lancee est ferme.
 *
 * Usage :
 *   npm run db:start
 *   npm run db:status
 *   npm run db:stop
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const action = process.argv[2] ?? 'start';
const dataDir = path.resolve(import.meta.dirname, '..', '.pgdata');
const logFile = path.join(dataDir, 'postgres.log');
const pidFile = path.join(dataDir, 'postmaster.pid');

function findPgCtl(): string {
  const binary = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  const root = path.resolve(import.meta.dirname, '..', 'node_modules', '@embedded-postgres');
  const candidates = readdirSync(root).map((name) => path.join(root, name, 'native', 'bin', binary));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`pg_ctl introuvable dans ${root}. Lancez npm install.`);
  }
  return found;
}

const pgCtl = findPgCtl();

function isRunning(): boolean {
  try {
    execFileSync(pgCtl, ['status', '-D', dataDir], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function removeStalePid(): void {
  if (!existsSync(pidFile)) return;
  const pid = Number(readFileSync(pidFile, 'utf8').split(/\r?\n/)[0]);
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }
  if (!alive) {
    rmSync(pidFile, { force: true });
    console.log(`Ancien PID ${pid || 'inconnu'} supprime.`);
  }
}

if (action === 'status') {
  if (!isRunning()) {
    console.log('PostgreSQL n est pas demarre.');
    process.exit(0);
  }
  execFileSync(pgCtl, ['status', '-D', dataDir], { stdio: 'inherit', windowsHide: true });
  process.exit(0);
}

if (action === 'stop') {
  if (!isRunning()) {
    console.log('PostgreSQL n est pas demarre.');
    process.exit(0);
  }
  execFileSync(pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], {
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exit(0);
}

if (action !== 'start') {
  console.error(`Action inconnue : ${action}. Utilisez start, status ou stop.`);
  process.exit(1);
}

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
  console.error('La base locale n est pas initialisee. Lancez d abord : npm run db:local');
  process.exit(1);
}

if (isRunning()) {
  console.log('PostgreSQL est deja demarre sur localhost:5432.');
  process.exit(0);
}

removeStalePid();

execFileSync(pgCtl, ['start', '-D', dataDir, '-l', logFile, '-w'], {
  stdio: 'inherit',
  windowsHide: true,
});
console.log('PostgreSQL est demarre sur localhost:5432 (processus detache).');
