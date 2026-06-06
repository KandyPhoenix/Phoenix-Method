import { describe, it, expect } from 'vitest';
import {
  countArticleWords,
  summarizeRefreshDiff,
  buildRefreshSystemPrompt,
  buildRefreshUserPrompt,
} from '../src/worker.js';

describe('countArticleWords', () => {
  it('returns 0 for null/empty/non-string', () => {
    expect(countArticleWords(null)).toBe(0);
    expect(countArticleWords(undefined)).toBe(0);
    expect(countArticleWords('')).toBe(0);
    expect(countArticleWords(123)).toBe(0);
  });

  it('strips HTML tags before counting', () => {
    expect(countArticleWords('<p>hello world</p>')).toBe(2);
    expect(countArticleWords('<h2>One Two Three</h2><p>four five</p>')).toBe(5);
  });

  it('handles HTML entities as whitespace', () => {
    expect(countArticleWords('hello&nbsp;world')).toBe(2);
    expect(countArticleWords('a&amp;b')).toBe(2);
  });

  it('collapses consecutive whitespace', () => {
    expect(countArticleWords('hello    world')).toBe(2);
    expect(countArticleWords('  hello\n\nworld  ')).toBe(2);
  });

  it('counts a realistic article body correctly', () => {
    const html = '<h2>Section One</h2><p>This is a paragraph with seven words here.</p><h2>Section Two</h2><p>Another short line.</p>';
    expect(countArticleWords(html)).toBe(15);
  });
});

describe('summarizeRefreshDiff', () => {
  it('handles empty inputs', () => {
    const diff = summarizeRefreshDiff('', '');
    expect(diff).toEqual({
      wordsBefore: 0,
      wordsAfter: 0,
      wordsDelta: 0,
      h2Before: 0,
      h2After: 0,
      h2Delta: 0,
    });
  });

  it('counts word delta correctly (growth)', () => {
    const before = '<p>three words here</p>';
    const after = '<p>now we have six words here</p>';
    const diff = summarizeRefreshDiff(before, after);
    expect(diff.wordsBefore).toBe(3);
    expect(diff.wordsAfter).toBe(6);
    expect(diff.wordsDelta).toBe(3);
  });

  it('counts word delta correctly (shrinkage)', () => {
    const before = '<p>this is five words total</p>';
    const after = '<p>three words now</p>';
    const diff = summarizeRefreshDiff(before, after);
    expect(diff.wordsDelta).toBe(-2);
  });

  it('counts H2 sections', () => {
    const before = '<h2>One</h2><p>x</p><h2>Two</h2><p>y</p>';
    const after = '<h2>One</h2><p>x</p><h2>Two</h2><p>y</p><h2>Three</h2><p>z</p>';
    const diff = summarizeRefreshDiff(before, after);
    expect(diff.h2Before).toBe(2);
    expect(diff.h2After).toBe(3);
    expect(diff.h2Delta).toBe(1);
  });

  it('counts H2 with attributes', () => {
    const html = '<h2 class="foo">A</h2><h2 id="x">B</h2>';
    const diff = summarizeRefreshDiff(html, html);
    expect(diff.h2Before).toBe(2);
  });

  it('does not count H3 or H1 as H2', () => {
    const html = '<h1>title</h1><h3>sub</h3><h2>real</h2>';
    const diff = summarizeRefreshDiff(html, html);
    expect(diff.h2Before).toBe(1);
  });
});

describe('buildRefreshSystemPrompt', () => {
  const prompt = buildRefreshSystemPrompt();

  it('returns a non-empty string', () => {
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(200);
  });

  it('instructs LLM to PRESERVE the slug', () => {
    expect(prompt).toMatch(/PRESERVE the original slug/i);
  });

  it('instructs LLM that this is a refresh, not a rewrite', () => {
    expect(prompt).toMatch(/refresh, not a rewrite/i);
  });

  it('instructs LLM to keep what is still good', () => {
    expect(prompt).toMatch(/keep what's still accurate/i);
  });

  it('declares the response schema as JSON only', () => {
    expect(prompt).toMatch(/single JSON object/i);
    expect(prompt).toMatch(/refreshNotes/);
  });

  it('forbids "delve" + buzzwords (style guardrail consistency)', () => {
    expect(prompt).toMatch(/Never use the word "delve"/);
    expect(prompt).toMatch(/leverage/);
  });

  it('keeps the FAQ-out-of-html rule from buildArticlePrompt', () => {
    expect(prompt).toMatch(/Do NOT include an FAQ section in the html/);
  });
});

describe('buildRefreshUserPrompt', () => {
  const article = {
    keyword: 'running shoes',
    slug: 'best-running-shoes',
    title: 'The Best Running Shoes',
    html: '<p>This is the original article body.</p>',
    publishedAt: '2026-01-15T00:00:00Z',
  };
  const site = { niche: 'fitness gear', brandVoice: 'casual and direct' };

  it('includes the target keyword in the user prompt', () => {
    const out = buildRefreshUserPrompt({ article, serpBrief: null, site });
    expect(out).toContain('running shoes');
  });

  it('includes the original slug with a preservation instruction', () => {
    const out = buildRefreshUserPrompt({ article, serpBrief: null, site });
    expect(out).toContain('best-running-shoes');
    expect(out).toMatch(/MUST preserve/i);
  });

  it('includes the original article HTML so the LLM sees it', () => {
    const out = buildRefreshUserPrompt({ article, serpBrief: null, site });
    expect(out).toContain('This is the original article body.');
  });

  it('includes brand voice sample', () => {
    const out = buildRefreshUserPrompt({ article, serpBrief: null, site });
    expect(out).toContain('casual and direct');
  });

  it('handles missing SERP brief gracefully with a fallback note', () => {
    const out = buildRefreshUserPrompt({ article, serpBrief: null, site });
    expect(out).toMatch(/no fresh SERP brief available/i);
  });

  it('includes site niche', () => {
    const out = buildRefreshUserPrompt({ article, serpBrief: null, site });
    expect(out).toContain('fitness gear');
  });

  it('falls back gracefully on missing/null article fields', () => {
    const sparse = { slug: '', title: '', html: '', keyword: '' };
    expect(() => buildRefreshUserPrompt({ article: sparse, serpBrief: null, site: {} })).not.toThrow();
  });

  it('prefers brandVoiceOverride over brandVoice when both present', () => {
    const out = buildRefreshUserPrompt({
      article,
      serpBrief: null,
      site: { brandVoiceOverride: 'override voice', brandVoice: 'default voice' },
    });
    expect(out).toContain('override voice');
    expect(out).not.toContain('default voice');
  });

  it('caps voice sample at 1500 chars to protect the prompt budget', () => {
    const longVoice = 'a'.repeat(3000);
    const out = buildRefreshUserPrompt({ article, serpBrief: null, site: { brandVoice: longVoice } });
    const voiceMatch = out.match(/"""\n(a+)\n"""/);
    expect(voiceMatch).toBeTruthy();
    expect(voiceMatch[1].length).toBe(1500);
  });
});
