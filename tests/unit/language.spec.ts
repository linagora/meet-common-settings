import { describe, expect, it } from 'vitest';
import { buildLanguageMapper } from '../../src/language.js';

describe('buildLanguageMapper', () => {
  const map = buildLanguageMapper();

  it.each([
    ['en', 'en-us'],
    ['fr', 'fr-fr'],
    ['nl', 'nl-nl'],
    ['de', 'de-de'],
    ['ru', 'ru-ru'],
    ['vi', 'vi-vn'],
  ])('maps %s → %s', (input, expected) => {
    expect(map(input)).toBe(expected);
  });

  it('passes through fully-qualified Meet backend codes unchanged', () => {
    expect(map('en-us')).toBe('en-us');
    expect(map('fr-fr')).toBe('fr-fr');
  });

  it('normalizes case and whitespace', () => {
    expect(map('  EN  ')).toBe('en-us');
    expect(map('FR-FR')).toBe('fr-fr');
  });

  it('falls back to base subtag when the full code is unsupported', () => {
    expect(map('en-gb')).toBe('en-us');
    expect(map('fr-ca')).toBe('fr-fr');
  });

  it('returns null for unsupported languages', () => {
    expect(map('xx')).toBeNull();
    expect(map('es')).toBeNull();
    expect(map('')).toBeNull();
  });

  it('honours overrides', () => {
    const custom = buildLanguageMapper({ es: 'fr-fr', en: 'nl-nl' });
    expect(custom('es')).toBe('fr-fr');
    expect(custom('en')).toBe('nl-nl');
  });
});
