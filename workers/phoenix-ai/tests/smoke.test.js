import { describe, it, expect } from 'vitest';

describe('vitest harness', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });

  it('supports async assertions', async () => {
    const value = await Promise.resolve('phoenix');
    expect(value).toBe('phoenix');
  });

  it('has access to URL + fetch globals that worker code relies on', () => {
    const u = new URL('https://example.com/post/1');
    expect(u.hostname).toBe('example.com');
    expect(typeof fetch).toBe('function');
  });
});
