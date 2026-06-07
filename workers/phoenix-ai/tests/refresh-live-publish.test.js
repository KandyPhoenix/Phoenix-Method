import { describe, it, expect } from 'vitest';
import { buildWpUpdatePayload } from '../src/worker.js';

describe('buildWpUpdatePayload', () => {
  const baseArticle = {
    title: 'Refreshed Title',
    slug: 'preserved-slug',
    content: '<p>refreshed body</p>',
    metaDescription: 'updated meta',
  };

  it('returns title + slug + content + excerpt as core fields', () => {
    const payload = buildWpUpdatePayload(baseArticle, []);
    expect(payload).toEqual({
      title: 'Refreshed Title',
      slug: 'preserved-slug',
      content: '<p>refreshed body</p>',
      excerpt: 'updated meta',
    });
  });

  it('NEVER includes featured_media (preserves existing hero on refresh)', () => {
    const payload = buildWpUpdatePayload(baseArticle, [1, 2, 3]);
    expect(payload).not.toHaveProperty('featured_media');
  });

  it('NEVER includes categories (preserves operator-set categories)', () => {
    const payload = buildWpUpdatePayload(baseArticle, [1, 2, 3]);
    expect(payload).not.toHaveProperty('categories');
  });

  it('NEVER includes status (refresh stays at whatever status WP already has)', () => {
    const payload = buildWpUpdatePayload(baseArticle, []);
    expect(payload).not.toHaveProperty('status');
  });

  it('includes tags when the tag IDs array is non-empty', () => {
    const payload = buildWpUpdatePayload(baseArticle, [12, 34, 56]);
    expect(payload.tags).toEqual([12, 34, 56]);
  });

  it('omits tags when the tag IDs array is empty', () => {
    expect(buildWpUpdatePayload(baseArticle, [])).not.toHaveProperty('tags');
  });

  it('omits tags when tag IDs is null/undefined', () => {
    expect(buildWpUpdatePayload(baseArticle, null)).not.toHaveProperty('tags');
    expect(buildWpUpdatePayload(baseArticle, undefined)).not.toHaveProperty('tags');
  });

  it('omits tags when tag IDs is not an array', () => {
    expect(buildWpUpdatePayload(baseArticle, 'not an array')).not.toHaveProperty('tags');
  });

  it('preserves slug exactly as passed (no normalization)', () => {
    const article = { ...baseArticle, slug: 'My-Original-Slug-123' };
    const payload = buildWpUpdatePayload(article, []);
    expect(payload.slug).toBe('My-Original-Slug-123');
  });

  it('passes through undefined fields without coercing them to empty strings', () => {
    const sparse = { slug: 'x' };
    const payload = buildWpUpdatePayload(sparse, []);
    expect(payload.slug).toBe('x');
    expect(payload.title).toBeUndefined();
    expect(payload.content).toBeUndefined();
    expect(payload.excerpt).toBeUndefined();
  });

  it('keeps content as the literal HTML string (no transformation)', () => {
    const article = { ...baseArticle, content: '<h2>One</h2><p>Two</p><script>x</script>' };
    const payload = buildWpUpdatePayload(article, []);
    expect(payload.content).toBe('<h2>One</h2><p>Two</p><script>x</script>');
  });

  it('returns same key shape regardless of optional inputs', () => {
    const withTags = buildWpUpdatePayload(baseArticle, [1]);
    const withoutTags = buildWpUpdatePayload(baseArticle, []);
    // Only tags should differ
    expect(Object.keys(withTags).sort()).toEqual(['content', 'excerpt', 'slug', 'tags', 'title']);
    expect(Object.keys(withoutTags).sort()).toEqual(['content', 'excerpt', 'slug', 'title']);
  });
});
