import { describe, expect, test } from 'bun:test';
import { parseTabs } from '../../src/admin/server';

describe('admin: parse gstack `tabs` output', () => {
  test('active marker, titles with dashes, untitled tabs', () => {
    const out = [
      '  [1] Example Domain — https://example.com/',
      '→ [3] Web browser - Wikipedia — https://en.wikipedia.org/wiki/Web_browser',
      '  [4] (untitled) — about:blank',
    ].join('\n');
    expect(parseTabs(out)).toEqual([
      { id: 1, active: false, title: 'Example Domain', url: 'https://example.com/' },
      { id: 3, active: true, title: 'Web browser - Wikipedia', url: 'https://en.wikipedia.org/wiki/Web_browser' },
      { id: 4, active: false, title: '', url: 'about:blank' },
    ]);
  });
  test('ignores wrapper and noise lines', () => {
    const out = '--- BEGIN UNTRUSTED EXTERNAL CONTENT ---\n→ [2] A — https://a.test/\n--- END UNTRUSTED EXTERNAL CONTENT ---\n';
    expect(parseTabs(out)).toEqual([{ id: 2, active: true, title: 'A', url: 'https://a.test/' }]);
  });
});
