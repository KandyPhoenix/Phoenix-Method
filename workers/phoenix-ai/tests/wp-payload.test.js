import { describe, it, expect } from 'vitest';
import { slugifyForWp, inferImageExtension } from '../src/worker.js';

describe('slugifyForWp', () => {
  it('returns empty string for null/undefined/empty', () => {
    expect(slugifyForWp(null)).toBe('');
    expect(slugifyForWp(undefined)).toBe('');
    expect(slugifyForWp('')).toBe('');
  });

  it('lowercases', () => {
    expect(slugifyForWp('Running Shoes')).toBe('running-shoes');
  });

  it('replaces whitespace with single dashes', () => {
    expect(slugifyForWp('best   running   shoes')).toBe('best-running-shoes');
  });

  it('strips punctuation', () => {
    expect(slugifyForWp("women's running shoes!")).toBe('womens-running-shoes');
  });

  it('collapses multiple dashes', () => {
    expect(slugifyForWp('foo -- bar')).toBe('foo-bar');
  });

  it('strips leading/trailing dashes', () => {
    expect(slugifyForWp('--hello world--')).toBe('hello-world');
    expect(slugifyForWp('  hello  ')).toBe('hello');
  });

  it('keeps numeric tokens', () => {
    expect(slugifyForWp('top 10 sneakers')).toBe('top-10-sneakers');
  });

  it('caps at 200 chars', () => {
    const long = 'a'.repeat(300);
    expect(slugifyForWp(long).length).toBe(200);
  });

  it('handles accented characters by stripping the accent', () => {
    // After NFD normalize + combining-mark strip, "café" → "cafe".
    expect(slugifyForWp('café')).toBe('cafe');
    expect(slugifyForWp('naïve résumé')).toBe('naive-resume');
  });

  it('removes characters outside the allowed alphabet', () => {
    expect(slugifyForWp('a@b#c$d')).toBe('abcd');
  });
});

describe('inferImageExtension', () => {
  it('defaults to jpg for null/undefined/empty', () => {
    expect(inferImageExtension(null)).toBe('jpg');
    expect(inferImageExtension(undefined)).toBe('jpg');
    expect(inferImageExtension('')).toBe('jpg');
  });

  it('returns jpg for image/jpeg', () => {
    expect(inferImageExtension('image/jpeg')).toBe('jpg');
  });

  it('returns jpg for unknown content types', () => {
    expect(inferImageExtension('application/octet-stream')).toBe('jpg');
    expect(inferImageExtension('image/svg+xml')).toBe('jpg');
  });

  it('returns png for image/png', () => {
    expect(inferImageExtension('image/png')).toBe('png');
  });

  it('returns webp for image/webp', () => {
    expect(inferImageExtension('image/webp')).toBe('webp');
  });

  it('returns gif for image/gif', () => {
    expect(inferImageExtension('image/gif')).toBe('gif');
  });

  it('is case-insensitive', () => {
    expect(inferImageExtension('IMAGE/PNG')).toBe('png');
    expect(inferImageExtension('Image/WebP')).toBe('webp');
  });

  it('tolerates content-type with charset/params', () => {
    expect(inferImageExtension('image/png; charset=utf-8')).toBe('png');
  });
});
