import { describe, it, expect } from 'vitest';
import {
  extractTitle,
  extractMetaDescription,
  extractHeadings,
  estimateWordCount,
  median,
  dedupNormalized,
  formatSerpBrief,
} from '../src/worker.js';

describe('extractTitle', () => {
  it('returns empty string for null/empty', () => {
    expect(extractTitle(null)).toBe('');
    expect(extractTitle('')).toBe('');
    expect(extractTitle('<html></html>')).toBe('');
  });

  it('extracts plain title', () => {
    expect(extractTitle('<title>Hello World</title>')).toBe('Hello World');
  });

  it('handles title with attributes', () => {
    expect(extractTitle('<title data-rh="true">My Page</title>')).toBe('My Page');
  });

  it('strips inner tags and collapses whitespace', () => {
    expect(extractTitle('<title>\n  Foo\n  <span>Bar</span>\n</title>')).toBe('Foo Bar');
  });

  it('takes only the first title when multiple are present', () => {
    expect(extractTitle('<title>First</title><title>Second</title>')).toBe('First');
  });
});

describe('extractMetaDescription', () => {
  it('returns empty string when missing', () => {
    expect(extractMetaDescription('<html><head></head></html>')).toBe('');
    expect(extractMetaDescription(null)).toBe('');
  });

  it('extracts content when name comes before content', () => {
    expect(
      extractMetaDescription('<meta name="description" content="A site about cats.">')
    ).toBe('A site about cats.');
  });

  it('extracts content when content comes before name', () => {
    expect(
      extractMetaDescription('<meta content="Reversed order." name="description">')
    ).toBe('Reversed order.');
  });

  it('handles single quotes', () => {
    expect(
      extractMetaDescription("<meta name='description' content='Single quotes work'>")
    ).toBe('Single quotes work');
  });

  it('tolerates extra attributes between name and content', () => {
    expect(
      extractMetaDescription('<meta name="description" data-rh="true" content="With extra attr">')
    ).toBe('With extra attr');
  });

  it('does not match og:description', () => {
    expect(
      extractMetaDescription('<meta name="og:description" content="OG only">')
    ).toBe('');
  });
});

describe('extractHeadings', () => {
  it('returns empty arrays for empty input', () => {
    const out = extractHeadings('');
    expect(out).toEqual({ h1: [], h2: [], h3: [] });
  });

  it('extracts multiple headings of each type', () => {
    const html = `
      <h1>The Page</h1>
      <h2>First Section</h2>
      <p>body</p>
      <h2>Second Section</h2>
      <h3>Subsection A</h3>
      <h3>Subsection B</h3>
    `;
    const out = extractHeadings(html);
    expect(out.h1).toEqual(['The Page']);
    expect(out.h2).toEqual(['First Section', 'Second Section']);
    expect(out.h3).toEqual(['Subsection A', 'Subsection B']);
  });

  it('strips inner tags and keeps text', () => {
    const out = extractHeadings('<h2>Hello <strong>bold</strong> world</h2>');
    expect(out.h2).toEqual(['Hello bold world']);
  });

  it('handles class + id attributes on heading tags', () => {
    const out = extractHeadings('<h2 class="section" id="intro">Intro</h2>');
    expect(out.h2).toEqual(['Intro']);
  });

  it('drops headings longer than 200 chars (template noise guard)', () => {
    const longText = 'a '.repeat(150);
    const out = extractHeadings(`<h2>${longText}</h2><h2>Short</h2>`);
    expect(out.h2).toEqual(['Short']);
  });

  it('collapses whitespace in heading text', () => {
    const out = extractHeadings('<h2>\n  Multi\n  Line\n</h2>');
    expect(out.h2).toEqual(['Multi Line']);
  });
});

describe('estimateWordCount', () => {
  it('returns 0 for empty input', () => {
    expect(estimateWordCount('')).toBe(0);
    expect(estimateWordCount(null)).toBe(0);
  });

  it('counts words in plain text', () => {
    expect(estimateWordCount('one two three')).toBe(3);
  });

  it('strips HTML tags', () => {
    expect(estimateWordCount('<p>one two <strong>three</strong></p>')).toBe(3);
  });

  it('ignores <script> blocks entirely', () => {
    expect(
      estimateWordCount('<p>visible words here</p><script>var x = 1; var y = 2;</script>')
    ).toBe(3);
  });

  it('ignores <style> blocks entirely', () => {
    expect(
      estimateWordCount('<style>body { color: red; }</style><p>actual content here</p>')
    ).toBe(3);
  });

  it('handles &nbsp; entities as whitespace', () => {
    expect(estimateWordCount('one&nbsp;two&nbsp;three')).toBe(3);
  });
});

describe('median', () => {
  it('returns null for empty or non-array input', () => {
    expect(median([])).toBeNull();
    expect(median(null)).toBeNull();
    expect(median('not-an-array')).toBeNull();
  });

  it('returns the middle element for odd-length arrays', () => {
    expect(median([1, 5, 3])).toBe(3);
  });

  it('returns the average of the two middle elements for even-length arrays', () => {
    expect(median([2, 4, 6, 8])).toBe(5);
  });

  it('rounds non-integer medians', () => {
    expect(median([1, 2, 3, 4])).toBe(3);
  });

  it('filters non-finite numbers before computing', () => {
    expect(median([10, 20, NaN, Infinity, 30])).toBe(20);
  });
});

describe('dedupNormalized', () => {
  it('returns empty array for empty input', () => {
    expect(dedupNormalized([])).toEqual([]);
    expect(dedupNormalized(null)).toEqual([]);
  });

  it('deduplicates exact matches', () => {
    expect(dedupNormalized(['Hello', 'World', 'Hello'])).toEqual(['Hello', 'World']);
  });

  it('deduplicates case-insensitively', () => {
    expect(dedupNormalized(['Hello', 'HELLO', 'hello'])).toEqual(['Hello']);
  });

  it('deduplicates ignoring punctuation differences', () => {
    expect(dedupNormalized(['Top 10!', 'top 10', 'top-10'])).toEqual(['Top 10!']);
  });

  it('preserves order of first occurrence', () => {
    expect(dedupNormalized(['B', 'A', 'b', 'a', 'C'])).toEqual(['B', 'A', 'C']);
  });

  it('drops non-string entries', () => {
    expect(dedupNormalized(['A', 42, null, 'B', undefined])).toEqual(['A', 'B']);
  });
});

describe('formatSerpBrief', () => {
  it('returns empty string for null brief', () => {
    expect(formatSerpBrief(null)).toBe('');
    expect(formatSerpBrief(undefined)).toBe('');
  });

  it('returns empty string when there are no H2 themes', () => {
    expect(formatSerpBrief({ pagesAnalyzed: 5, medianWordCount: 1500, commonH2Themes: [] })).toBe('');
  });

  it('formats a brief with all fields', () => {
    const out = formatSerpBrief({
      pagesAnalyzed: 8,
      medianWordCount: 1800,
      commonH2Themes: ['What is X', 'How X works', 'Common X mistakes'],
    });
    expect(out).toContain('top 8 ranking pages');
    expect(out).toContain('Median word count of ranking pages: 1800');
    expect(out).toContain('  - What is X');
    expect(out).toContain('  - Common X mistakes');
    expect(out).toContain('covers the terrain Google already rewards');
  });

  it('omits the median word count line when null', () => {
    const out = formatSerpBrief({
      pagesAnalyzed: 3,
      medianWordCount: null,
      commonH2Themes: ['One', 'Two'],
    });
    expect(out).not.toContain('Median word count');
    expect(out).toContain('  - One');
  });
});
