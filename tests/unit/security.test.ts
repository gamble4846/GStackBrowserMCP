// Fast checks for the security-critical pure functions. Run: bun test tests/unit
import { describe, expect, test } from 'bun:test';
import { isBlockedIp } from '../../src/egress/egressProxy';
import { isLoopbackHost } from '../../src/core/sessionProxy';
import { deniedReason, redactArgs, validateNested } from '../../src/core/commandCatalog';
import { normalizeAuthState } from '../../src/core/authState';

describe('egress: private addresses are blocked', () => {
  test.each([
    '10.1.2.3', '127.0.0.1', '192.168.1.6', '172.16.0.1', '172.31.255.255', '169.254.169.254',
    '100.64.0.1', '100.97.23.127', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd12::1', 'fe80::1', '::ffff:192.168.1.6',
  ])('%s is blocked', (ip) => expect(isBlockedIp(ip)).toBe(true));
  test.each(['93.184.215.14', '104.20.23.154', '172.32.0.1', '100.128.0.1', '2606:4700::6810:1'])('%s is allowed', (ip) => expect(isBlockedIp(ip)).toBe(false));
});

describe('session proxy: loopback is recognised by name (tunnel routing)', () => {
  test.each(['localhost', 'LOCALHOST', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '0.0.0.0', 'app.localhost'])('%s → tunnel', (h) => expect(isLoopbackHost(h)).toBe(true));
  test.each(['example.com', 'localhost.example.com', '192.168.1.6', '10.0.0.1'])('%s → egress', (h) => expect(isLoopbackHost(h)).toBe(false));
});

describe('command catalog', () => {
  test('denies local-only and dangerous commands', () => {
    for (const c of ['cookie-import-browser', 'connect', 'pair-agent', 'skill', 'handoff', 'restart']) expect(deniedReason(c)).not.toBeNull();
    for (const c of ['goto', 'snapshot', 'click', 'screenshot', 'js', 'chain']) expect(deniedReason(c)).toBeNull();
  });
  test('nested chain commands are checked too', () => {
    expect(validateNested([['goto', 'https://x'], ['connect']])).toContain('connect');
    expect(validateNested([['goto', 'https://x'], ['text']])).toBeNull();
  });
  test('secrets are redacted for the audit log', () => {
    expect(redactArgs('fill', ['#pw', 'hunter2'])[1]).not.toContain('hunter2');
    expect(redactArgs('header', ['Authorization:Bearer abc'])[0]).not.toContain('abc');
    expect(redactArgs('cookie', ['sid=secret'])[0]).not.toContain('secret');
    expect(redactArgs('storage', ['set', 'token', 'xyz'])[2]).not.toContain('xyz');
  });
});

describe('auth state normalisation', () => {
  test('Playwright storageState with sessionStorage', () => {
    const { state } = normalizeAuthState({
      cookies: [{ name: 'sid', value: 'v', domain: '.example.com', path: '/', expires: 4102444800, httpOnly: true, secure: true, sameSite: 'None' }],
      origins: [{ origin: 'https://app.example.com/ignored', localStorage: [{ name: 'a', value: '1' }], sessionStorage: [{ name: 's', value: '2' }] }],
    });
    expect(state.cookies[0]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'None', expires: 4102444800 });
    expect(state.origins[0]).toMatchObject({ origin: 'https://app.example.com', sessionStorage: [{ name: 's', value: '2' }] });
  });
  test('Cookie-Editor export (expirationDate, no_restriction, hostOnly)', () => {
    const { state } = normalizeAuthState([{ name: 'sid', value: 'v', domain: 'app.example.com', hostOnly: true, expirationDate: 4102444800.5, sameSite: 'no_restriction', secure: true, httpOnly: true, path: '/' }]);
    expect(state.cookies[0]).toMatchObject({ domain: 'app.example.com', sameSite: 'None', expires: 4102444800 });
  });
  test('sameSite None without secure falls back to Lax (browsers reject it otherwise)', () => {
    const { state } = normalizeAuthState([{ name: 'a', value: 'b', domain: 'x.com', sameSite: 'None', secure: false }]);
    expect(state.cookies[0].sameSite).toBe('Lax');
  });
  test('expired cookies are dropped with a warning', () => {
    const { state, warnings } = normalizeAuthState({ cookies: [{ name: 'old', value: 'v', domain: 'x.com', expires: 1000 }, { name: 'ok', value: 'v', domain: 'x.com' }] });
    expect(state.cookies.map((c) => c.name)).toEqual(['ok']);
    expect(warnings.join()).toContain('old');
  });
  test('plain localStorage map needs an origin', () => {
    expect(() => normalizeAuthState({ localStorage: { a: '1' } })).toThrow('origin');
    expect(normalizeAuthState({ localStorage: { a: '1' } }, 'http://localhost:3000').state.origins[0].origin).toBe('http://localhost:3000');
  });
  test('rejects non-http origins and empty states', () => {
    expect(() => normalizeAuthState({ origins: [{ origin: 'file:///etc' }] })).toThrow();
    expect(() => normalizeAuthState({})).toThrow('no cookies');
  });
});
