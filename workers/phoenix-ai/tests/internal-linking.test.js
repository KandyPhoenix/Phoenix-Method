import { describe, it, expect } from 'vitest';
import {
  stripTagsCollapse,
  validateInternalLinks,
} from '../src/worker.js';

describe('stripTagsCollapse', () => {
  it('returns empty string for null/undefined', () => {
    expect(stripTagsCollapse(null)).toBe('');
    expect(stripTagsCollapse(undefined)).toBe('');
  });

  it('passes through plain text trimmed', () => {
    expect(stripTagsCollapse('  hello world  ')).toBe('hello world');
  });

  it('strips HTML tags and keeps inner text', () => {
    expect(stripTagsCollapse('<p>Hi <strong>there</strong></p>')).toBe('Hi there');
  });

  it('collapses runs of whitespace into single spaces', () => {
    expect(stripTagsCollapse('a\n\n\tb   c')).toBe('a b c');
  });

  it('handles WordPress-style nested tags from excerpt.rendered', () => {
    expect(
      stripTagsCollapse('<p>The post excerpt&hellip;</p>\n')
    ).toBe('The post excerpt&hellip;');
  });
});

describe('validateInternalLinks', () => {
  const site = { url: 'https://example.com' };

  it('returns html unchanged with zero counters when allowedUrls is empty', () => {
    const html = '<p>Hi <a href="https://example.com/post-a">link</a></p>';
    const out = validateInternalLinks(html, site, []);
    expect(out.html).toBe(html);
    expect(out).toMatchObject({ kept: 0, stripped: 0, total: 0 });
  });

  it('returns html unchanged when there are no links', () => {
    const html = '<p>Just text, no links.</p>';
    const out = validateInternalLinks(html, site, ['https://example.com/post-a']);
    expect(out.html).toBe(html);
    expect(out).toMatchObject({ kept: 0, stripped: 0, total: 0 });
  });

  it('keeps an internal link whose absolute href is in the allowlist', () => {
    const html = '<p>See <a href="https://example.com/post-a">post A</a>.</p>';
    const out = validateInternalLinks(html, site, ['https://example.com/post-a']);
    expect(out.html).toBe(html);
    expect(out).toMatchObject({ kept: 1, stripped: 0, total: 1 });
  });

  it('strips an internal link that is NOT in the allowlist (anti-hallucination)', () => {
    const html = '<p>See <a href="https://example.com/made-up">invented post</a>.</p>';
    const out = validateInternalLinks(html, site, ['https://example.com/real-post']);
    expect(out.html).toBe('<p>See invented post.</p>');
    expect(out).toMatchObject({ kept: 0, stripped: 1, total: 1 });
  });

  it('keeps external links untouched even when allowlist is empty of them', () => {
    const html = '<p>Per <a href="https://other-site.com/study">a study</a>.</p>';
    const out = validateInternalLinks(html, site, ['https://example.com/post-a']);
    expect(out.html).toBe(html);
    expect(out).toMatchObject({ kept: 1, stripped: 0, total: 1 });
  });

  it('resolves relative hrefs against site.url and matches against the normalized URL', () => {
    const html = '<p>See <a href="/post-a">it</a>.</p>';
    const out = validateInternalLinks(html, site, ['https://example.com/post-a']);
    expect(out.html).toBe(html);
    expect(out).toMatchObject({ kept: 1, stripped: 0, total: 1 });
  });

  it('strips an anchor with a malformed href (defensive — treat as internal, kick out)', () => {
    const html = '<p>Bad <a href="ht!tp://broken">link</a>.</p>';
    const out = validateInternalLinks(html, site, ['https://example.com/post-a']);
    expect(out.html).toBe('<p>Bad link.</p>');
    expect(out).toMatchObject({ kept: 0, stripped: 1, total: 1 });
  });

  it('handles a mix of kept-external, kept-internal-allowed, and stripped-internal-hallucinated', () => {
    const html = [
      '<p>External <a href="https://nytimes.com/x">source</a>.</p>',
      '<p>Real <a href="https://example.com/real">internal</a>.</p>',
      '<p>Fake <a href="https://example.com/fake">internal</a>.</p>',
    ].join('\n');
    const out = validateInternalLinks(html, site, ['https://example.com/real']);
    expect(out).toMatchObject({ kept: 2, stripped: 1, total: 3 });
    expect(out.html).toContain('<a href="https://nytimes.com/x">source</a>');
    expect(out.html).toContain('<a href="https://example.com/real">internal</a>');
    expect(out.html).not.toContain('href="https://example.com/fake"');
    expect(out.html).toContain('Fake internal.');
  });

  it('preserves anchor attributes other than href when keeping a link', () => {
    const html = '<p>See <a href="https://example.com/p" rel="noopener" target="_blank">it</a>.</p>';
    const out = validateInternalLinks(html, site, ['https://example.com/p']);
    expect(out.html).toBe(html);
    expect(out).toMatchObject({ kept: 1, stripped: 0, total: 1 });
  });

  it('treats a malformed site.url defensively (siteHost empty → all links read as external & kept)', () => {
    const html = '<p>See <a href="https://example.com/p">link</a>.</p>';
    const out = validateInternalLinks(html, { url: 'not a url' }, ['https://example.com/p']);
    expect(out).toMatchObject({ kept: 1, stripped: 0, total: 1 });
  });
});
