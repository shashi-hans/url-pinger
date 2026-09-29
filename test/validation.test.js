import { describe, it, expect } from 'vitest';
import validation from '../src/validation.js';

const { isPrivateHostname, validateTargetUrl, validateHeaders, validateTargetInput } = validation;

describe('isPrivateHostname', () => {
  const blocked = [
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.9',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    'metadata.google.internal',
    'db.internal',
    'printer.local',
    '::1',
    '[fd00::1]',
    'fe80::1',
  ];
  const allowed = ['example.com', '8.8.8.8', '172.32.0.1', '172.15.0.1', 'api.example.co.in'];

  it.each(blocked)('blocks %s', (host) => {
    expect(isPrivateHostname(host)).toBe(true);
  });

  it.each(allowed)('allows %s', (host) => {
    expect(isPrivateHostname(host)).toBe(false);
  });
});

describe('validateTargetUrl', () => {
  it('accepts a public https URL', () => {
    expect(validateTargetUrl('https://example.com/health').ok).toBe(true);
  });

  it('rejects a non-http scheme', () => {
    const r = validateTargetUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/http or https/);
  });

  it('rejects embedded credentials', () => {
    const r = validateTargetUrl('https://user:secret@example.com/');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/credentials/);
  });

  it('rejects a private address under the default policy', () => {
    const r = validateTargetUrl('http://169.254.169.254/latest/meta-data/');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/SSRF/);
  });

  it('rejects a malformed URL', () => {
    expect(validateTargetUrl('not a url').ok).toBe(false);
  });
});

describe('validateHeaders', () => {
  it('accepts plain string headers', () => {
    expect(validateHeaders({ Accept: 'application/json' })).toEqual([]);
  });

  it('rejects a header value containing a line break', () => {
    const errors = validateHeaders({ 'X-Test': 'a\r\nInjected: 1' });
    expect(errors[0]).toMatch(/line breaks/);
  });

  it('rejects a non-string value', () => {
    expect(validateHeaders({ 'X-Test': 5 })[0]).toMatch(/must be strings/);
  });

  it('rejects an invalid header name', () => {
    expect(validateHeaders({ 'Bad Header': 'x' })[0]).toMatch(/valid HTTP header name/);
  });
});

describe('validateTargetInput', () => {
  const valid = { name: 'health', url: 'https://example.com/health', intervalSeconds: 60 };

  it('accepts a minimal target', () => {
    expect(validateTargetInput(valid)).toEqual({ ok: true, errors: [] });
  });

  it('requires name, url and interval on create', () => {
    const r = validateTargetInput({});
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(3);
  });

  it('rejects an interval below the floor', () => {
    const r = validateTargetInput({ ...valid, intervalSeconds: 0 });
    expect(r.errors[0]).toMatch(/at least/);
  });

  it('rejects a fractional interval', () => {
    const r = validateTargetInput({ ...valid, intervalSeconds: 1.5 });
    expect(r.errors[0]).toMatch(/whole number/);
  });

  it('rejects an unknown method', () => {
    const r = validateTargetInput({ ...valid, method: 'FETCH' });
    expect(r.errors[0]).toMatch(/method must be one of/);
  });

  it('allows a partial patch that only toggles enabled', () => {
    expect(validateTargetInput({ enabled: false }, { partial: true }).ok).toBe(true);
  });

  it('rejects a non-boolean enabled', () => {
    const r = validateTargetInput({ enabled: 'yes' }, { partial: true });
    expect(r.errors[0]).toMatch(/enabled must be a boolean/);
  });
});
