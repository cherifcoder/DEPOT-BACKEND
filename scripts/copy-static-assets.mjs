// Copie les ressources statiques (logo du depot, ...) dans dist/ apres la
// compilation TypeScript. Ces fichiers sont servis tels quels par Vercel
// (outputDirectory = dist) : https://<domaine>/logo.png
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');

mkdirSync(dist, { recursive: true });
copyFileSync(path.join(root, 'assets', 'logo.png'), path.join(dist, 'logo.png'));

console.log('Ressources statiques copiees dans dist/ (logo.png).');
