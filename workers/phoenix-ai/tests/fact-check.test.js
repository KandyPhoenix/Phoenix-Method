import { describe, it, expect } from 'vitest';
import {
  summarizeFactCheck,
  lowConfidenceClaims,
  annotateFlaggedClaims,
} from '../src/worker.js';

describe('summarizeFactCheck', () => {
  it('returns zeros for empty/non-array input', () => {
    expect(summarizeFactCheck([])).toEqual({ total: 0, lowConfidence: 0, byType: {} });
    expect(summarizeFactCheck(null)).toEqual({ total: 0, lowConfidence: 0, byType: {} });
    expect(summarizeFactCheck('nope')).toEqual({ total: 0, lowConfidence: 0, byType: {} });
  });

  it('counts total claims and groups by type', () => {
    const claims = [
      { type: 'stat', plausibilityScore: 8 },
      { type: 'stat', plausibilityScore: 3 },
      { type: 'citation', plausibilityScore: 9 },
      { type: 'assertion', plausibilityScore: 4 },
    ];
    const out = summarizeFactCheck(claims);
    expect(out.total).toBe(4);
    expect(out.byType).toEqual({ stat: 2, citation: 1, assertion: 1 });
  });

  it('counts low-confidence claims below the default threshold of 5', () => {
    const claims = [
      { type: 'stat', plausibilityScore: 8 },
      { type: 'stat', plausibilityScore: 4 }, // low
      { type: 'stat', plausibilityScore: 5 }, // exactly at threshold — NOT low
      { type: 'stat', plausibilityScore: 1 }, // low
    ];
    expect(summarizeFactCheck(claims).lowConfidence).toBe(2);
  });

  it('respects a custom threshold', () => {
    const claims = [
      { type: 'stat', plausibilityScore: 6 },
      { type: 'stat', plausibilityScore: 7 },
      { type: 'stat', plausibilityScore: 8 },
    ];
    expect(summarizeFactCheck(claims, 7).lowConfidence).toBe(1);
  });

  it('falls back to `score` field when `plausibilityScore` is absent', () => {
    const claims = [
      { type: 'stat', score: 3 },
      { type: 'stat', score: 8 },
    ];
    expect(summarizeFactCheck(claims).lowConfidence).toBe(1);
  });

  it('does not count claims with no usable score as low-confidence', () => {
    const claims = [
      { type: 'stat' },
      { type: 'stat', plausibilityScore: 'not-a-number' },
      { type: 'stat', plausibilityScore: NaN },
    ];
    const out = summarizeFactCheck(claims);
    expect(out.total).toBe(3);
    expect(out.lowConfidence).toBe(0);
  });

  it('treats missing type as "unknown"', () => {
    expect(summarizeFactCheck([{ plausibilityScore: 9 }]).byType).toEqual({ unknown: 1 });
  });

  it('skips non-object entries', () => {
    expect(summarizeFactCheck([null, 'string', 42, { type: 'stat', plausibilityScore: 8 }]).total).toBe(1);
  });
});

describe('lowConfidenceClaims', () => {
  it('returns empty array for empty/non-array input', () => {
    expect(lowConfidenceClaims([])).toEqual([]);
    expect(lowConfidenceClaims(null)).toEqual([]);
  });

  it('returns only claims below the default threshold (5)', () => {
    const claims = [
      { text: 'a', plausibilityScore: 8 },
      { text: 'b', plausibilityScore: 4 },
      { text: 'c', plausibilityScore: 2 },
    ];
    expect(lowConfidenceClaims(claims).map((c) => c.text)).toEqual(['b', 'c']);
  });

  it('respects a custom threshold', () => {
    const claims = [
      { text: 'a', plausibilityScore: 5 },
      { text: 'b', plausibilityScore: 7 },
      { text: 'c', plausibilityScore: 8 },
    ];
    expect(lowConfidenceClaims(claims, 8).map((c) => c.text)).toEqual(['a', 'b']);
  });

  it('skips claims with no usable score', () => {
    const claims = [
      { text: 'a' },
      { text: 'b', plausibilityScore: 'whatever' },
      { text: 'c', plausibilityScore: 3 },
    ];
    expect(lowConfidenceClaims(claims).map((c) => c.text)).toEqual(['c']);
  });
});

describe('annotateFlaggedClaims', () => {
  const articleHtml = '<p>Per a study by Pew Research, 40% of small businesses use AI. According to a 2025 Gartner report, the figure is 67%. Also, 99% of restaurants use TikTok.</p>';

  it('returns unchanged html when claims is empty or non-array', () => {
    expect(annotateFlaggedClaims(articleHtml, [])).toEqual({ html: articleHtml, annotated: 0 });
    expect(annotateFlaggedClaims(articleHtml, null)).toEqual({ html: articleHtml, annotated: 0 });
  });

  it('returns empty html when input html is empty', () => {
    expect(annotateFlaggedClaims('', [{ text: 'anything', plausibilityScore: 2, reason: 'r' }])).toEqual({ html: '', annotated: 0 });
  });

  it('wraps a found claim with <mark> carrying score + reason', () => {
    const claims = [{ text: '99% of restaurants use TikTok', plausibilityScore: 2, reason: 'implausible' }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.annotated).toBe(1);
    expect(out.html).toContain('<mark class="pm-fact-flag" data-score="2" title="implausible">99% of restaurants use TikTok</mark>');
  });

  it('skips a claim whose text is not in the article verbatim', () => {
    const claims = [{ text: 'this exact text is not present', plausibilityScore: 1, reason: 'ghost' }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.annotated).toBe(0);
    expect(out.html).toBe(articleHtml);
  });

  it('annotates multiple claims at distinct positions', () => {
    const claims = [
      { text: '40% of small businesses use AI', plausibilityScore: 4, reason: 'unverified' },
      { text: '99% of restaurants use TikTok', plausibilityScore: 1, reason: 'implausible' },
    ];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.annotated).toBe(2);
    expect(out.html).toContain('data-score="4"');
    expect(out.html).toContain('data-score="1"');
  });

  it('matches claim text case-insensitively but preserves original casing in the wrap', () => {
    const claims = [{ text: '40% OF SMALL BUSINESSES use AI', plausibilityScore: 3, reason: 'r' }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.annotated).toBe(1);
    // Original casing preserved inside the <mark>
    expect(out.html).toContain('>40% of small businesses use AI</mark>');
  });

  it('escapes the reason attribute for safe injection into title=""', () => {
    const claims = [{
      text: '99% of restaurants use TikTok',
      plausibilityScore: 1,
      reason: 'They said "no source" & <script>alert(1)</script>',
    }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.annotated).toBe(1);
    expect(out.html).toContain('&quot;no source&quot;');
    expect(out.html).toContain('&amp;');
    expect(out.html).toContain('&lt;script&gt;');
    expect(out.html).not.toContain('<script>alert');
  });

  it('falls back to `score` when `plausibilityScore` is missing', () => {
    const claims = [{ text: '99% of restaurants use TikTok', score: 1, reason: 'r' }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.html).toContain('data-score="1"');
  });

  it('emits empty data-score when neither score field is usable', () => {
    const claims = [{ text: '99% of restaurants use TikTok', reason: 'r' }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.html).toContain('data-score=""');
  });

  it('uses a default reason when none is supplied', () => {
    const claims = [{ text: '99% of restaurants use TikTok', plausibilityScore: 2 }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.html).toContain('title="flagged for review"');
  });

  it('skips claims shorter than 4 characters (high false-positive risk)', () => {
    const claims = [{ text: 'AI', plausibilityScore: 1, reason: 'too short' }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.annotated).toBe(0);
  });

  it('skips a claim whose match falls inside an existing tag attribute', () => {
    const html = '<p class="foo">visible 99% claim</p>';
    const claims = [{ text: 'foo', plausibilityScore: 1, reason: 'r' }];
    const out = annotateFlaggedClaims(html, claims);
    expect(out.annotated).toBe(0);
    expect(out.html).toBe(html);
  });

  it('handles trimming of claim text', () => {
    const claims = [{ text: '  99% of restaurants use TikTok  ', plausibilityScore: 2, reason: 'r' }];
    const out = annotateFlaggedClaims(articleHtml, claims);
    expect(out.annotated).toBe(1);
  });
});
