import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    DEFAULT_SETTINGS,
    normalizeLocale,
    normalizeTheme,
    sanitizeSettings,
} from '@contracts/settings';

describe('settings-sanitizer', () => {
    it('returns defaults when settings payload is missing', () => {
        expect(sanitizeSettings(undefined)).toEqual({
            ...DEFAULT_SETTINGS,
            skippedUpdateVersion: undefined,
            suppressDefaultViewerPrompt: undefined,
        });
    });

    it('preserves valid locale and dark theme', () => {
        expect(sanitizeSettings({
            version: 3,
            authorName: 'Alice',
            theme: 'dark',
            locale: 'fr',
        })).toEqual({
            ...DEFAULT_SETTINGS,
            version: 3,
            authorName: 'Alice',
            theme: 'dark',
            locale: 'fr',
            skippedUpdateVersion: undefined,
            suppressDefaultViewerPrompt: undefined,
        });
    });

    it('normalizes invalid locale/theme and trims skipped update version', () => {
        expect(sanitizeSettings({
            version: 1,
            authorName: 'Bob',
            theme: 'midnight' as 'light',
            locale: 'xx' as 'en',
            skippedUpdateVersion: '  1.2.3  ',
            suppressDefaultViewerPrompt: true,
        })).toEqual({
            ...DEFAULT_SETTINGS,
            version: 1,
            authorName: 'Bob',
            theme: 'light',
            locale: 'en',
            skippedUpdateVersion: '1.2.3',
            suppressDefaultViewerPrompt: true,
        });
    });

    it('exposes locale/theme normalizers for shared callers', () => {
        expect(normalizeTheme('dark')).toBe('dark');
        expect(normalizeTheme('contrast')).toBe('light');
        expect(normalizeLocale('ru')).toBe('ru');
        expect(normalizeLocale('xx')).toBe('en');
    });
});
