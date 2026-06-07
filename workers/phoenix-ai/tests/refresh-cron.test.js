import { describe, it, expect } from 'vitest';
import { shouldRunRefreshForSite, summarizeCronRefreshResults } from '../src/worker.js';

describe('shouldRunRefreshForSite', () => {
  const baseSite = {
    status: 'active',
    refreshEnabled: true,
    cms: 'wordpress',
    appPassword: 'encrypted-blob',
  };

  it('returns false for null/undefined/non-object', () => {
    expect(shouldRunRefreshForSite(null)).toBe(false);
    expect(shouldRunRefreshForSite(undefined)).toBe(false);
    expect(shouldRunRefreshForSite('not a site')).toBe(false);
  });

  it('returns true for a happy WP site', () => {
    expect(shouldRunRefreshForSite(baseSite)).toBe(true);
  });

  it('returns true for a happy GitHub Pages site', () => {
    const gh = { status: 'active', refreshEnabled: true, cms: 'github-pages', githubToken: 'pat-blob' };
    expect(shouldRunRefreshForSite(gh)).toBe(true);
  });

  it('returns false when refreshEnabled is false/missing', () => {
    expect(shouldRunRefreshForSite({ ...baseSite, refreshEnabled: false })).toBe(false);
    expect(shouldRunRefreshForSite({ ...baseSite, refreshEnabled: undefined })).toBe(false);
  });

  it('returns false when status is not active', () => {
    expect(shouldRunRefreshForSite({ ...baseSite, status: 'paused' })).toBe(false);
    expect(shouldRunRefreshForSite({ ...baseSite, status: 'archived' })).toBe(false);
    expect(shouldRunRefreshForSite({ ...baseSite, status: undefined })).toBe(false);
  });

  it('returns false for WP site missing appPassword', () => {
    expect(shouldRunRefreshForSite({ ...baseSite, appPassword: '' })).toBe(false);
    expect(shouldRunRefreshForSite({ ...baseSite, appPassword: null })).toBe(false);
  });

  it('returns false for GitHub Pages site missing githubToken', () => {
    const gh = { status: 'active', refreshEnabled: true, cms: 'github-pages' };
    expect(shouldRunRefreshForSite(gh)).toBe(false);
  });

  it('returns true for non-WP non-github CMS without credentials gate (manual)', () => {
    // The credentials gate is CMS-specific; a manual CMS has nothing to check.
    const manual = { status: 'active', refreshEnabled: true, cms: 'manual' };
    expect(shouldRunRefreshForSite(manual)).toBe(true);
  });

  it('does not require refreshAutoPublish to be set (default-false is fine for staging-only)', () => {
    // refreshAutoPublish gates the publish leg, not the refresh trigger itself.
    expect(shouldRunRefreshForSite({ ...baseSite, refreshAutoPublish: false })).toBe(true);
    expect(shouldRunRefreshForSite({ ...baseSite, refreshAutoPublish: undefined })).toBe(true);
  });
});

describe('summarizeCronRefreshResults', () => {
  it('returns zeroed counters for empty input', () => {
    expect(summarizeCronRefreshResults([])).toEqual({
      sitesConsidered: 0,
      refreshesStaged: 0,
      refreshesPublished: 0,
      refreshesFailed: 0,
      refreshesSkipped: 0,
    });
  });

  it('returns zeroed counters for null/non-array input', () => {
    expect(summarizeCronRefreshResults(null).sitesConsidered).toBe(0);
    expect(summarizeCronRefreshResults('not array').sitesConsidered).toBe(0);
  });

  it('counts a single staged refresh (no auto-publish)', () => {
    const out = summarizeCronRefreshResults([
      { ok: true, refreshed: true, published: false, siteId: 's1' },
    ]);
    expect(out.refreshesStaged).toBe(1);
    expect(out.refreshesPublished).toBe(0);
    expect(out.sitesConsidered).toBe(1);
  });

  it('counts a single staged+published refresh', () => {
    const out = summarizeCronRefreshResults([
      { ok: true, refreshed: true, published: true, siteId: 's1' },
    ]);
    expect(out.refreshesPublished).toBe(1);
    expect(out.refreshesStaged).toBe(0);
  });

  it('counts a skipped site (no eligible article)', () => {
    const out = summarizeCronRefreshResults([
      { ok: true, skipped: 'no_eligible', siteId: 's1' },
    ]);
    expect(out.refreshesSkipped).toBe(1);
    expect(out.refreshesStaged).toBe(0);
  });

  it('counts a failed refresh as a failure (not staged or published)', () => {
    const out = summarizeCronRefreshResults([
      { ok: false, error: 'llm timeout', siteId: 's1' },
    ]);
    expect(out.refreshesFailed).toBe(1);
    expect(out.refreshesStaged).toBe(0);
    expect(out.refreshesPublished).toBe(0);
  });

  it('aggregates a mixed batch correctly', () => {
    const out = summarizeCronRefreshResults([
      { ok: true, skipped: 'no_eligible', siteId: 's1' },
      { ok: true, refreshed: true, published: false, siteId: 's2' },
      { ok: true, refreshed: true, published: true, siteId: 's3' },
      { ok: true, refreshed: true, published: true, siteId: 's4' },
      { ok: false, error: 'something', siteId: 's5' },
      { ok: false, error: 'something else', siteId: 's6' },
    ]);
    expect(out.sitesConsidered).toBe(6);
    expect(out.refreshesSkipped).toBe(1);
    expect(out.refreshesStaged).toBe(1);
    expect(out.refreshesPublished).toBe(2);
    expect(out.refreshesFailed).toBe(2);
  });

  it('skips null/undefined/non-object entries without crashing', () => {
    const out = summarizeCronRefreshResults([
      null,
      undefined,
      'not an object',
      { ok: true, refreshed: true, published: false, siteId: 's1' },
    ]);
    expect(out.sitesConsidered).toBe(4); // raw array length
    expect(out.refreshesStaged).toBe(1);
    expect(out.refreshesFailed).toBe(0);
    expect(out.refreshesSkipped).toBe(0);
  });

  it('a single result is counted in exactly one bucket (no double-count between staged + published)', () => {
    const out = summarizeCronRefreshResults([
      { ok: true, refreshed: true, published: true },
    ]);
    expect(out.refreshesPublished).toBe(1);
    expect(out.refreshesStaged).toBe(0); // published implies staged but we count once
  });

  it('failure with staged: true (publish failed) counts as failure, not staged', () => {
    const out = summarizeCronRefreshResults([
      { ok: false, error: 'wp 500', siteId: 's1', slug: 'x', staged: true },
    ]);
    expect(out.refreshesFailed).toBe(1);
    expect(out.refreshesStaged).toBe(0);
  });
});
