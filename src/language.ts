const DJANGO_LANGUAGES = new Set(['en-us', 'fr-fr', 'nl-nl', 'de-de']);

const DEFAULT_MAP: Record<string, string> = {
  en: 'en-us',
  fr: 'fr-fr',
  nl: 'nl-nl',
  de: 'de-de',
};

export type LanguageMapper = (input: string) => string | null;

export const buildLanguageMapper = (overrides: Record<string, string> = {}): LanguageMapper => {
  const map: Record<string, string> = { ...DEFAULT_MAP, ...overrides };
  return (input: string) => {
    const normalized = input.trim().toLowerCase();
    if (DJANGO_LANGUAGES.has(normalized)) return normalized;
    if (map[normalized]) return map[normalized] ?? null;
    const base = normalized.split('-')[0];
    if (base && map[base]) return map[base] ?? null;
    return null;
  };
};
