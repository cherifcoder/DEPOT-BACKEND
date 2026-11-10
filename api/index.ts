/**
 * Entrée serverless Vercel.
 *
 * Vercel invoque la fonction par défaut avec (req, res) : une application
 * Express est directement compatible. Le `vercel.json` du projet réécrit
 * toutes les routes vers cette fonction et l'URL d'origine de la requête
 * est transmise telle quelle à Express (routes `/health`, `/api/...`,
 * `/files/...`).
 *
 * Le démarrage classique en serveur autonome reste `npm run dev`
 * (voir `src/index.ts`).
 */
import { createApp } from '../src/app.js';

const app = createApp();

export default app;
