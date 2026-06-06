import { describe, it, expect } from 'vitest';
import { daysBetween, isRefreshEligible } from '../src/worker.js';

describe('daysBetween', () => {
  it('returns Infinity when either side is null/undefined/empty', () => {
    expect(daysBetween(null, '2026-01-01T00:00:00Z')).toBe(Infinity);
    expect(daysBetween('2026-01-01T00:00:00Z', null)).toBe(Infinity);
    expect(daysBetween(undefined, undefined)).toBe(Infinity);
    expect(daysBetween('', '2026-01-01T00:00:00Z')).toBe(Infinity);
  });

  it('returns Infinity for unparseable timestamps', () => {
    expect(daysBetween('not a date', '2026-01-01T00:00:00Z')).toBe(Infinity);
    expect(daysBetween('2026-01-01T00:00:00Z', 'bogus')).toBe(Infinity);
  });

  it('returns whole-day difference for valid timestamps', () => {
    expect(daysBetween('2026-01-11T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(10);
    expect(daysBetween('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(1);
    expect(daysBetween('2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')).toBe(0);
  });

  it('returns negative for earlier > later (no clamp)', () => {
    expect(daysBetween('2026-01-01T00:00:00Z', '2026-01-11T00:00:00Z')).toBe(-10);
  });

  it('floors fractional days', () => {
    // 23 hours apart → 0 whole days
    expect(daysBetween('2026-01-02T00:00:00Z', '2026-01-01T01:00:00Z')).toBe(0);
    // 25 hours apart → 1 whole day
    expect(daysBetween('2026-01-02T02:00:00Z', '2026-01-01T01:00:00Z')).toBe(1);
  });
});

describe('isRefreshEligible', () => {
  const NOW = '2026-06-01T00:00:00Z';
  const baseSettings = { refreshEnabled: true, refreshAfterDays: 90 };
  const basePublished = {
    wpPostId: 123,
    status: 'publish',
    publishedAt: '2026-01-01T00:00:00Z', // 151 days before NOW
    lastRefreshedAt: null,
  };

  it('returns false when article is null/undefined/non-object', () => {
    expect(isRefreshEligible(null, baseSettings, NOW)).toBe(false);
    expect(isRefreshEligible(undefined, baseSettings, NOW)).toBe(false);
    expect(isRefreshEligible('not an object', baseSettings, NOW)).toBe(false);
  });

  it('returns false when refresh is disabled in settings', () => {
    expect(isRefreshEligible(basePublished, { refreshEnabled: false }, NOW)).toBe(false);
    expect(isRefreshEligible(basePublished, {}, NOW)).toBe(false);
    expect(isRefreshEligible(basePublished, null, NOW)).toBe(false);
  });

  it('returns true for a published, old, never-refreshed article', () => {
    expect(isRefreshEligible(basePublished, baseSettings, NOW)).toBe(true);
  });

  it('accepts githubPath as proof of publication', () => {
    const gh = { ...basePublished, wpPostId: null, githubPath: '/blog/post.html' };
    expect(isRefreshEligible(gh, baseSettings, NOW)).toBe(true);
  });

  it('accepts status=publish as proof of publication', () => {
    const s = { ...basePublished, wpPostId: null, githubPath: null, status: 'publish' };
    expect(isRefreshEligible(s, baseSettings, NOW)).toBe(true);
  });

  it('returns false when article has no proof of publication', () => {
    const unpub = { ...basePublished, wpPostId: null, githubPath: null, status: 'draft' };
    expect(isRefreshEligible(unpub, baseSettings, NOW)).toBe(false);
  });

  it('returns false for rejected articles', () => {
    expect(isRefreshEligible({ ...basePublished, status: 'rejected' }, baseSettings, NOW)).toBe(false);
  });

  it('returns false for failed articles', () => {
    expect(isRefreshEligible({ ...basePublished, status: 'failed' }, baseSettings, NOW)).toBe(false);
  });

  it('returns false when article is missing publishedAt', () => {
    expect(isRefreshEligible({ ...basePublished, publishedAt: null }, baseSettings, NOW)).toBe(false);
  });

  it('returns false when article is younger than refreshAfterDays', () => {
    const young = { ...basePublished, publishedAt: '2026-05-15T00:00:00Z' }; // 17 days old
    expect(isRefreshEligible(young, baseSettings, NOW)).toBe(false);
  });

  it('returns false when article was refreshed within refreshAfterDays', () => {
    const recentlyRefreshed = {
      ...basePublished,
      lastRefreshedAt: '2026-05-01T00:00:00Z', // 31 days ago, < 90
    };
    expect(isRefreshEligible(recentlyRefreshed, baseSettings, NOW)).toBe(false);
  });

  it('returns true when last refresh was older than refreshAfterDays', () => {
    const longAgo = {
      ...basePublished,
      lastRefreshedAt: '2026-01-15T00:00:00Z', // 137 days ago, > 90
    };
    expect(isRefreshEligible(longAgo, baseSettings, NOW)).toBe(true);
  });

  it('honors custom refreshAfterDays', () => {
    const article = { ...basePublished, publishedAt: '2026-05-20T00:00:00Z' }; // 12 days old
    expect(isRefreshEligible(article, { refreshEnabled: true, refreshAfterDays: 7 }, NOW)).toBe(true);
    expect(isRefreshEligible(article, { refreshEnabled: true, refreshAfterDays: 30 }, NOW)).toBe(false);
  });

  it('clamps refreshAfterDays to a minimum of 1 when 0/negative passed', () => {
    const article = { ...basePublished, publishedAt: '2026-05-30T12:00:00Z' }; // ~1.5 days old
    expect(isRefreshEligible(article, { refreshEnabled: true, refreshAfterDays: 0 }, NOW)).toBe(true);
    expect(isRefreshEligible(article, { refreshEnabled: true, refreshAfterDays: -50 }, NOW)).toBe(true);
  });

  it('defaults refreshAfterDays to 90 when omitted', () => {
    const ninetyOneDayOld = { ...basePublished, publishedAt: '2026-03-01T00:00:00Z' }; // 92 days
    const eightyDayOld = { ...basePublished, publishedAt: '2026-03-13T00:00:00Z' }; // 80 days
    expect(isRefreshEligible(ninetyOneDayOld, { refreshEnabled: true }, NOW)).toBe(true);
    expect(isRefreshEligible(eightyDayOld, { refreshEnabled: true }, NOW)).toBe(false);
  });
});
