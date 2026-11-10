import { describe, expect, it } from 'vitest';
import { canSyncEntity } from './sync.routes.js';

describe('canSyncEntity', () => {
  it('applique les memes droits que les routes directes', () => {
    expect(canSyncEntity(['VENDEUR'], 'sale')).toBe(true);
    expect(canSyncEntity(['VENDEUR'], 'payment')).toBe(true);
    expect(canSyncEntity(['VENDEUR'], 'loss')).toBe(true);
    expect(canSyncEntity(['VENDEUR'], 'expense')).toBe(false);
    expect(canSyncEntity(['COMPTABLE'], 'expense')).toBe(true);
    expect(canSyncEntity(['LIVREUR'], 'delivery')).toBe(true);
    expect(canSyncEntity(['LIVREUR'], 'sale')).toBe(false);
    expect(canSyncEntity(['LIVREUR'], 'loss')).toBe(false);
  });

  it('autorise toujours ADMIN', () => {
    for (const entity of ['sale', 'payment', 'loss', 'expense', 'delivery'] as const) {
      expect(canSyncEntity(['ADMIN'], entity)).toBe(true);
    }
  });
});
