import { describe, it } from 'node:test';
import assert from 'node:assert';
import { formatAssetTable, type Asset } from '../lib/assets/index.js';

describe('asset module - formatting', () => {
  it('formatAssetTable returns formatted string with headers', () => {
    const assets: Asset[] = [
      {
        id: '1',
        name: 'test-domain.com',
        type: 'domain',
        status: 'active',
        owner: 'oracle',
        metadata: {},
        expires_at: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
    ];
    const result = formatAssetTable(assets);
    assert.match(result, /Type/);
    assert.match(result, /Status/);
    assert.match(result, /test-domain\.com/);
    assert.match(result, /Total: 1 assets/);
  });

  it('formatAssetTable handles empty list', () => {
    const result = formatAssetTable([]);
    assert.equal(result, 'No assets found.');
  });

  it('formatAssetTable truncates long names', () => {
    const longName = 'a'.repeat(50) + '.com';
    const assets: Asset[] = [
      {
        id: '1',
        name: longName,
        type: 'domain',
        status: 'active',
        owner: 'oracle',
        metadata: {},
        expires_at: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
    ];
    const result = formatAssetTable(assets);
    // Should be truncated to 35 chars max (32 + ...)
    assert.match(result, /\.\.\./);
  });

  it('formatAssetTable shows all columns', () => {
    const assets: Asset[] = [
      {
        id: '1',
        name: 'my-server',
        type: 'server',
        status: 'inactive',
        owner: 'carlos',
        metadata: {},
        expires_at: '2026-12-31',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      },
    ];
    const result = formatAssetTable(assets);
    assert.match(result, /Server/);
    assert.match(result, /inactive/);
    assert.match(result, /carlos/);
    assert.match(result, /2026-12-31/);
  });
});