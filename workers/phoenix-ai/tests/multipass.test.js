import { describe, it, expect } from 'vitest';
import { splitArticleByH2, applyRevisions } from '../src/worker.js';

describe('splitArticleByH2', () => {
  it('returns empty array for null/empty input', () => {
    expect(splitArticleByH2('')).toEqual([]);
    expect(splitArticleByH2(null)).toEqual([]);
  });

  it('returns one section with empty heading when there is no H2', () => {
    const html = '<p>Just an intro, no headings.</p>';
    expect(splitArticleByH2(html)).toEqual([{ heading: '', block: html }]);
  });

  it('captures content before the first H2 as an intro section with empty heading', () => {
    const html = '<p>Intro text.</p><h2>First</h2><p>body</p>';
    const out = splitArticleByH2(html);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ heading: '', block: '<p>Intro text.</p>' });
    expect(out[1].heading).toBe('First');
    expect(out[1].block).toBe('<h2>First</h2><p>body</p>');
  });

  it('splits multiple H2 sections', () => {
    const html = '<h2>One</h2><p>a</p><h2>Two</h2><p>b</p><h2>Three</h2><p>c</p>';
    const out = splitArticleByH2(html);
    expect(out).toHaveLength(3);
    expect(out.map((s) => s.heading)).toEqual(['One', 'Two', 'Three']);
    expect(out[0].block).toBe('<h2>One</h2><p>a</p>');
    expect(out[1].block).toBe('<h2>Two</h2><p>b</p>');
    expect(out[2].block).toBe('<h2>Three</h2><p>c</p>');
  });

  it('handles H2 with attributes', () => {
    const html = '<h2 id="x" class="foo">Title</h2><p>body</p>';
    const out = splitArticleByH2(html);
    expect(out[0].heading).toBe('Title');
    expect(out[0].block).toBe(html);
  });

  it('strips inner tags from the heading text but preserves them in the block', () => {
    const html = '<h2>Plain <strong>and bold</strong></h2><p>body</p>';
    const out = splitArticleByH2(html);
    expect(out[0].heading).toBe('Plain and bold');
    expect(out[0].block).toBe(html);
  });

  it('does not interfere with H3 inside a section', () => {
    const html = '<h2>One</h2><p>a</p><h3>sub</h3><p>b</p><h2>Two</h2><p>c</p>';
    const out = splitArticleByH2(html);
    expect(out).toHaveLength(2);
    expect(out[0].block).toBe('<h2>One</h2><p>a</p><h3>sub</h3><p>b</p>');
    expect(out[1].block).toBe('<h2>Two</h2><p>c</p>');
  });

  it('collapses whitespace in heading text', () => {
    const out = splitArticleByH2('<h2>\n  Multi\n  Line\n</h2><p>x</p>');
    expect(out[0].heading).toBe('Multi Line');
  });
});

describe('applyRevisions', () => {
  const articleHtml = '<p>Intro.</p><h2>What is X</h2><p>old A</p><h2>How X works</h2><p>old B</p><h2>Common mistakes</h2><p>old C</p>';

  it('no-ops when revisionsMap is missing or empty', () => {
    expect(applyRevisions(articleHtml, null)).toEqual({ html: articleHtml, applied: 0, requested: 0 });
    expect(applyRevisions(articleHtml, {})).toEqual({ html: articleHtml, applied: 0, requested: 0 });
  });

  it('no-ops when article html is empty', () => {
    expect(applyRevisions('', { Foo: '<h2>Foo</h2>' })).toEqual({ html: '', applied: 0, requested: 1 });
  });

  it('substitutes a single matched section', () => {
    const revisions = { 'What is X': '<h2>What is X</h2><p>NEW A</p>' };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.applied).toBe(1);
    expect(out.requested).toBe(1);
    expect(out.html).toContain('<p>NEW A</p>');
    expect(out.html).not.toContain('<p>old A</p>');
    expect(out.html).toContain('<p>old B</p>');
    expect(out.html).toContain('<p>old C</p>');
  });

  it('substitutes multiple matched sections', () => {
    const revisions = {
      'What is X': '<h2>What is X</h2><p>NEW A</p>',
      'Common mistakes': '<h2>Common mistakes</h2><p>NEW C</p>',
    };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.applied).toBe(2);
    expect(out.requested).toBe(2);
    expect(out.html).toContain('<p>NEW A</p>');
    expect(out.html).toContain('<p>NEW C</p>');
    expect(out.html).toContain('<p>old B</p>');
  });

  it('preserves the intro before the first H2', () => {
    const revisions = { 'What is X': '<h2>What is X</h2><p>NEW A</p>' };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.html.startsWith('<p>Intro.</p>')).toBe(true);
  });

  it('matches headings case-insensitively', () => {
    const revisions = { 'WHAT IS X': '<h2>WHAT IS X</h2><p>NEW A</p>' };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.applied).toBe(1);
    expect(out.html).toContain('<p>NEW A</p>');
  });

  it('matches headings ignoring whitespace differences', () => {
    const revisions = { 'What  is\nX': '<h2>What is X</h2><p>NEW A</p>' };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.applied).toBe(1);
  });

  it('counts requested even when a key has empty/non-string value (but skips it)', () => {
    const revisions = {
      'What is X': '<h2>What is X</h2><p>NEW A</p>',
      'How X works': '',
      'Common mistakes': null,
    };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.requested).toBe(1);
    expect(out.applied).toBe(1);
  });

  it('silently ignores revisions whose heading does not match any H2', () => {
    const revisions = {
      'What is X': '<h2>What is X</h2><p>NEW A</p>',
      'Section that does not exist': '<h2>Ghost</h2><p>nope</p>',
    };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.requested).toBe(2);
    expect(out.applied).toBe(1);
    expect(out.html).not.toContain('Ghost');
    expect(out.html).not.toContain('nope');
  });

  it('returns applied 0 when none of the revisions match any heading', () => {
    const revisions = { 'Made up': '<h2>Made up</h2><p>x</p>' };
    const out = applyRevisions(articleHtml, revisions);
    expect(out.applied).toBe(0);
    expect(out.html).toBe(articleHtml);
  });

  it('handles an article with no H2s (revisions all no-op)', () => {
    const html = '<p>Just text, no headings.</p>';
    const revisions = { 'Anything': '<h2>Anything</h2><p>x</p>' };
    const out = applyRevisions(html, revisions);
    expect(out.applied).toBe(0);
    expect(out.html).toBe(html);
  });
});
