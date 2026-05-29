import { describe, it, expect } from 'vitest';
import { clusterKeywords, tokenizeKeyword } from '../src/worker.js';

describe('tokenizeKeyword', () => {
  it('returns empty array for null/empty', () => {
    expect(tokenizeKeyword(null)).toEqual([]);
    expect(tokenizeKeyword(undefined)).toEqual([]);
    expect(tokenizeKeyword('')).toEqual([]);
  });

  it('lowercases and splits on whitespace', () => {
    expect(tokenizeKeyword('Running Shoes')).toEqual(['running', 'shoes']);
  });

  it('strips stopwords from the fixed list', () => {
    expect(tokenizeKeyword('best running shoes for women')).toEqual(['running', 'shoes', 'women']);
    expect(tokenizeKeyword('how to choose a provider')).toEqual(['choose', 'provider']);
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(tokenizeKeyword("women's running shoes!")).toEqual(['women', 's', 'running', 'shoes']);
  });

  it('returns empty array when input is all stopwords', () => {
    expect(tokenizeKeyword('what is the best')).toEqual([]);
  });

  it('keeps numeric tokens', () => {
    expect(tokenizeKeyword('top 10 sneakers')).toEqual(['10', 'sneakers']);
  });
});

describe('clusterKeywords', () => {
  it('returns empty array for empty/non-array input', () => {
    expect(clusterKeywords([])).toEqual([]);
    expect(clusterKeywords(null)).toEqual([]);
  });

  it('single keyword becomes a pillar with clusterId 1', () => {
    const out = clusterKeywords([{ keyword: 'running shoes', volume: 1000 }]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ keyword: 'running shoes', volume: 1000, clusterId: 1, isPillar: true });
  });

  it('two unrelated keywords become two pillars in two clusters', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes' },
      { keyword: 'dog food' },
    ]);
    expect(out.map((k) => k.clusterId)).toEqual([1, 2]);
    expect(out.every((k) => k.isPillar)).toBe(true);
  });

  it('groups broader and narrower terms into the same cluster with the broader term as pillar', () => {
    const out = clusterKeywords([
      { keyword: 'best running shoes for women', volume: 5000 },
      { keyword: 'running shoes', volume: 8000 },
      { keyword: 'running shoe reviews', volume: 3000 },
    ]);
    // All three should share a cluster.
    const clusterIds = new Set(out.map((k) => k.clusterId));
    expect(clusterIds.size).toBe(1);
    // The pillar should be "running shoes" (2 tokens — fewest after stopword strip).
    const pillar = out.find((k) => k.isPillar);
    expect(pillar.keyword).toBe('running shoes');
    // Only one pillar per cluster.
    expect(out.filter((k) => k.isPillar)).toHaveLength(1);
  });

  it('preserves input order in the output array', () => {
    const out = clusterKeywords([
      { keyword: 'best running shoes for women' },
      { keyword: 'dog food' },
      { keyword: 'running shoes' },
    ]);
    expect(out.map((k) => k.keyword)).toEqual([
      'best running shoes for women',
      'dog food',
      'running shoes',
    ]);
  });

  it('preserves all original fields on each keyword', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes', volume: 1000, kd: 18, intent: 'commercial', score: 42, isManual: true },
    ]);
    expect(out[0]).toMatchObject({ keyword: 'running shoes', volume: 1000, kd: 18, intent: 'commercial', score: 42, isManual: true });
    expect(out[0].clusterId).toBe(1);
    expect(out[0].isPillar).toBe(true);
  });

  it('handles transitive clustering via union-find (A↔B, B↔C all share a cluster)', () => {
    // "running shoes" overlaps "trail running" via "running"
    // "trail running" overlaps "trail" via "trail" (singleton, will not be standalone)
    // Just test the basic transitive case:
    const out = clusterKeywords([
      { keyword: 'running shoes' },        // tokens: [running, shoes]
      { keyword: 'trail running shoes' },  // tokens: [trail, running, shoes] — overlaps with above
      { keyword: 'trail running' },        // tokens: [trail, running] — overlaps with middle
    ]);
    const clusterIds = new Set(out.map((k) => k.clusterId));
    expect(clusterIds.size).toBe(1);
  });

  it('three completely unrelated groups produce three pillars', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes' },
      { keyword: 'running shoe reviews' },     // → cluster 1 (running shoes pillar)
      { keyword: 'dog food' },
      { keyword: 'dog food brands' },          // → cluster 2 (dog food pillar)
      { keyword: 'birthday party games' },     // → cluster 3 (singleton pillar)
    ]);
    expect(new Set(out.map((k) => k.clusterId)).size).toBe(3);
    expect(out.filter((k) => k.isPillar)).toHaveLength(3);
  });

  it('keyword with no usable tokens (all stopwords) becomes its own singleton pillar', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes' },
      { keyword: 'what is the best' },
    ]);
    expect(out[1].clusterId).not.toBe(out[0].clusterId);
    expect(out[1].isPillar).toBe(true);
  });

  it('assigns clusterIds in order of first occurrence', () => {
    const out = clusterKeywords([
      { keyword: 'dog food' },           // → cluster 1
      { keyword: 'running shoes' },      // → cluster 2
      { keyword: 'dog treats' },         // → cluster 1 (overlap with dog food via "dog")
    ]);
    expect(out[0].clusterId).toBe(1);
    expect(out[1].clusterId).toBe(2);
    expect(out[2].clusterId).toBe(1);
  });

  it('when two keywords tie on token count, the earlier one (higher upstream score) becomes pillar', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes', volume: 8000 },  // tokens: 2
      { keyword: 'shoes running', volume: 5000 },  // tokens: 2 — tie
    ]);
    // Same cluster (both have running + shoes).
    expect(out[0].clusterId).toBe(out[1].clusterId);
    // First one is pillar on tie.
    expect(out[0].isPillar).toBe(true);
    expect(out[1].isPillar).toBe(false);
  });

  it('tolerates missing/empty keyword fields without crashing', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes' },
      { keyword: '' },
      { },
      { keyword: null },
    ]);
    expect(out).toHaveLength(4);
    // Each item that has no tokens becomes its own singleton.
    expect(new Set(out.map((k) => k.clusterId)).size).toBe(4);
  });

  it('every output keyword has exactly one of isPillar=true or isPillar=false (boolean, no nulls)', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes' },
      { keyword: 'best running shoes' },
      { keyword: 'dog food' },
    ]);
    for (const k of out) {
      expect(typeof k.isPillar).toBe('boolean');
      expect(typeof k.clusterId).toBe('number');
      expect(k.clusterId).toBeGreaterThanOrEqual(1);
    }
  });

  it('exactly one pillar per cluster', () => {
    const out = clusterKeywords([
      { keyword: 'running shoes' },
      { keyword: 'best running shoes' },
      { keyword: 'running shoe reviews' },
      { keyword: 'dog food' },
      { keyword: 'best dog food brands' },
    ]);
    const byCluster = {};
    for (const k of out) {
      byCluster[k.clusterId] = byCluster[k.clusterId] || { pillars: 0, total: 0 };
      byCluster[k.clusterId].total++;
      if (k.isPillar) byCluster[k.clusterId].pillars++;
    }
    for (const stats of Object.values(byCluster)) {
      expect(stats.pillars).toBe(1);
    }
  });
});
