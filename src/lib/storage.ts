import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../env.js';
import { ApiError } from './errors.js';

export type MediaFolder = 'products' | 'signatures' | 'deliveries' | 'receipts' | 'settings';

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  pdf: 'application/pdf',
};

export const uploadRoot = path.resolve(process.cwd(), env.UPLOAD_DIR);

export async function ensureStorage(): Promise<void> {
  const folders: MediaFolder[] = ['products', 'signatures', 'deliveries', 'receipts', 'settings'];
  await Promise.all([mkdir(uploadRoot, { recursive: true }), ...folders.map((folder) => mkdir(path.join(uploadRoot, folder), { recursive: true }))]);
}

export interface StoredMedia {
  /** URL relative servie par l'API : /files/products/xxx.jpg */
  url: string;
  filename: string;
  size: number;
  mimeType: string;
}

export async function saveBuffer(
  buffer: Buffer,
  folder: MediaFolder,
  mimeType: string,
  preferredExtension?: string,
): Promise<StoredMedia> {
  const extension = preferredExtension ?? EXTENSION_BY_MIME[mimeType];
  if (!extension || !MIME_BY_EXTENSION[extension]) {
    throw ApiError.badRequest(`Format de fichier non supporte : ${mimeType}`);
  }

  const maxBytes = env.MAX_UPLOAD_MB * 1024 * 1024;
  if (buffer.byteLength > maxBytes) {
    throw ApiError.badRequest(`Fichier trop volumineux (max ${env.MAX_UPLOAD_MB} Mo)`);
  }

  await ensureStorage();

  const filename = `${Date.now()}-${randomUUID()}.${extension}`;
  await writeFile(path.join(uploadRoot, folder, filename), buffer);

  return {
    url: `/files/${folder}/${filename}`,
    filename,
    size: buffer.byteLength,
    mimeType: MIME_BY_EXTENSION[extension] ?? mimeType,
  };
}

const DATA_URL_PATTERN = /^data:(image\/(?:png|jpe?g|webp));base64,([A-Za-z0-9+/=\s]+)$/;

/** Convertit une signature capturee cote mobile (data URL base64) en fichier PNG/JPG. */
export async function saveSignature(dataUrl: string): Promise<StoredMedia> {
  const match = DATA_URL_PATTERN.exec(dataUrl.trim());
  if (!match?.[1] || !match[2]) {
    throw ApiError.badRequest('Signature invalide : data URL image base64 attendue');
  }

  const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
  const buffer = Buffer.from(match[2].replace(/\s/g, ''), 'base64');

  if (buffer.byteLength < 100) throw ApiError.badRequest('Signature vide');
  if (buffer.byteLength > 2 * 1024 * 1024) throw ApiError.badRequest('Signature trop volumineuse (max 2 Mo)');

  return saveBuffer(buffer, 'signatures', mimeType);
}

/** Lit un media stocke localement a partir de son URL publique relative. */
export async function readMedia(url: string | null | undefined): Promise<Buffer | null> {
  if (!url?.startsWith('/files/')) return null;

  const relative = url.slice('/files/'.length);
  const normalized = path.normalize(relative).replace(/^(\.\.[/\\])+/, '');
  const absolute = path.join(uploadRoot, normalized);

  if (!absolute.startsWith(uploadRoot)) return null;

  try {
    return await readFile(absolute);
  } catch {
    return null;
  }
}

/** URL absolue utilisable par un client externe (PDF, partage). */
export function absoluteMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/^https?:\/\//.test(url)) return url;
  return `${env.PUBLIC_BASE_URL.replace(/\/$/, '')}${url}`;
}
