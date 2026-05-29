import { describe, it, expect } from 'vitest';
import { normalizeKeywordKey, diffKeywordLists, aggregateGapKeywords } from '../src/worker.js';

describe('normalizeKeywordKey', () => {
  it('returns empty string for null/empty', () => {
    expect(normalizeKeywordKey(null)).toBe('');
    expect(normalizeKeywordKey(undefined)).toBe('');
    expect(normalizeKeywordKey('')).toBe('');
  });

  it('lowercases', () => {
    expect(normalizeKeywordKey('Running Shoes')).toBe('running shoes');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeKeywordKey('running   shoes')).toBe('running shoes');
    expect(normalizeKeywordKey('running\tshoes')).toBe('running shoes');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeKeywordKey('  running shoes  ')).toBe('running shoes');
  });
});

describe('diffKeywordLists', () => {
  it('returns empty for empty/non-array theirs', () => {
    expect(diffKeywordLists([], [{ keyword: 'x' }])).toEqual([]);
    expect(diffKeywordLists(null, [{ keyword: 'x' }])).toEqual([]);
  });

  it('returns everything from theirs when ours is empty', () => {
    const theirs = [{ keyword: 'a' }, { keyword: 'b' }];
    expect(diffKeywordLists(theirs, [])).toEqual(theirs);
    expect(diffKeywordLists(theirs, null)).toEqual(theirs);
  });

  it('removes keywords from theirs that are present in ours', () => {
    const theirs = [{ keyword: 'a' }, { keyword: 'b' }, { keyword: 'c' }];
    const ours = [{ keyword: 'b' }];
    expect(diffKeywordLists(theirs, ours).map((k) => k.keyword)).toEqual(['a', 'c']);
  });

  it('matches keywords case-insensitively', () => {
    const theirs = [{ keyword: 'Running Shoes' }];
    const ours = [{ keyword: 'running shoes' }];
    expect(diffKeywordLists(theirs, ours)).toEqual([]);
  });

  it('matches keywords with normalized whitespace', () => {
    const theirs = [{ keyword: 'running shoes' }];
    const ours = [{ keyword: '  running   shoes  ' }];
    expect(diffKeywordLists(theirs, ours)).toEqual([]);
  });

  it('preserves order of theirs', () => {
    const theirs = [{ keyword: 'c' }, { keyword: 'a' }, { keyword: 'b' }];
    const ours = [{ keyword: 'a' }];
    expect(diffKeywordLists(theirs, ours).map((k) => k.keyword)).toEqual(['c', 'b']);
  });

  it('skips theirs entries with missing keyword field', () => {
    const theirs = [{ keyword: 'a' }, { volume: 100 }, { keyword: '' }, { keyword: 'b' }];
    expect(diffKeywordLists(theirs, []).map((k) => k.keyword)).toEqual(['a', 'b']);
  });
});

describe('aggregateGapKeywords', () => {
  it('returns empty array for null/empty input', () => {
    expect(aggregateGapKeywords(null)).toEqual([]);
    expect(aggregateGapKeywords({})).toEqual([]);
  });

  it('aggregates a single competitor list into individual gap entries', () => {
    const out = aggregateGapKeywords({
      'competitor1.com': [
        { keyword: 'a', volume: 1000, kd: 10, intent: 'commercial' },
        { keyword: 'b', volume: 500, kd: 5, intent: 'informational' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out.every((k) => k.competitorCount === 1)).toBe(true);
    expect(out.every((k) => k.competitors.length === 1 && k.competitors[0] === 'competitor1.com')).toBe(true);
  });

  it('groups a keyword shared by multiple competitors and counts them', () => {
    const out = aggregateGapKeywords({
      'a.com': [{ keyword: 'shared kw', volume: 1000, kd: 10, intent: 'commercial' }],
      'b.com': [{ keyword: 'shared kw', volume: 1100, kd: 12, intent: 'commercial' }],
      'c.com': [{ keyword: 'shared kw', volume: 950, kd: 11, intent: 'commercial' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].competitorCount).toBe(3);
    expect(out[0].competitors).toEqual(['a.com', 'b.com', 'c.com']);
  });

  it('uses normalized key for grouping but preserves original casing in output', () => {
    const out = aggregateGapKeywords({
      'a.com': [{ keyword: 'Running Shoes', volume: 1000, kd: 10, intent: 'commercial' }],
      'b.com': [{ keyword: 'running shoes', volume: 1100, kd: 12, intent: 'commercial' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].competitorCount).toBe(2);
    // First occurrence wins for casing.
    expect(out[0].keyword).toBe('Running Shoes');
  });

  it('sorts by leverage = competitorCount × log2(volume+1) - kd, descending', () => {
    const out = aggregateGapKeywords({
      'a.com': [
        { keyword: 'low-leverage', volume: 100, kd: 50, intent: 'informational' },
        { keyword: 'mid-leverage', volume: 5000, kd: 20, intent: 'informational' },
      ],
      'b.com': [
        { keyword: 'high-leverage', volume: 2000, kd: 10, intent: 'informational' },
        { keyword: 'mid-leverage', volume: 5000, kd: 20, intent: 'informational' },
      ],
    });
    // mid-leverage is shared by 2 competitors → should be at the top.
    expect(out[0].keyword).toBe('mid-leverage');
    expect(out[0].competitorCount).toBe(2);
  });

  it('uses first occurrence values for volume/kd/intent', () => {
    const out = aggregateGapKeywords({
      'a.com': [{ keyword: 'kw', volume: 1000, kd: 10, intent: 'commercial' }],
      'b.com': [{ keyword: 'kw', volume: 9999, kd: 99, intent: 'transactional' }],
    });
    expect(out[0].volume).toBe(1000);
    expect(out[0].kd).toBe(10);
    expect(out[0].intent).toBe('commercial');
  });

  it('skips entries without a keyword field', () => {
    const out = aggregateGapKeywords({
      'a.com': [{ keyword: 'good' }, { volume: 100 }, { keyword: '' }, null],
    });
    expect(out).toHaveLength(1);
    expect(out[0].keyword).toBe('good');
  });

  it('handles competitor list that is not an array', () => {
    const out = aggregateGapKeywords({
      'a.com': [{ keyword: 'a' }],
      'b.com': 'not an array',
    });
    expect(out).toHaveLength(1);
  });

  it('defaults intent to "informational" when missing', () => {
    const out = aggregateGapKeywords({
      'a.com': [{ keyword: 'kw', volume: 100, kd: 5 }],
    });
    expect(out[0].intent).toBe('informational');
  });

  it('never lists the same competitor twice for the same keyword', () => {
    const out = aggregateGapKeywords({
      'a.com': [
        { keyword: 'kw', volume: 100 },
        { keyword: 'kw', volume: 200 },  // same keyword appearing twice from same domain
      ],
    });
    expect(out[0].competitors).toEqual(['a.com']);
    expect(out[0].competitorCount).toBe(1);
  });
});
