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

    it('normalizes tab memory policy', () => {
        expect(sanitizeSettings({tabMemoryPolicy: 'aggressive'}).tabMemoryPolicy).toBe('aggressive');
        expect(sanitizeSettings({tabMemoryPolicy: 'unsupported' as never}).tabMemoryPolicy).toBe(DEFAULT_SETTINGS.tabMemoryPolicy);
    });

    it('normalizes agent MCP setting', () => {
        expect(sanitizeSettings({agentMcpEnabled: true}).agentMcpEnabled).toBe(true);
        expect(sanitizeSettings({agentMcpEnabled: 'yes'}).agentMcpEnabled).toBe(false);
    });

    it('normalizes assistant panel setting', () => {
        expect(sanitizeSettings({assistantPanelEnabled: false}).assistantPanelEnabled).toBe(false);
        expect(sanitizeSettings({assistantPanelEnabled: 'no'}).assistantPanelEnabled).toBe(true);
    });

    it('trims and clamps unbounded string settings', () => {
        expect(sanitizeSettings({
            authorName: `  ${'A'.repeat(300)}  `,
            skippedUpdateVersion: `  ${'1'.repeat(160)}  `,
        })).toMatchObject({
            authorName: 'A'.repeat(256),
            skippedUpdateVersion: '1'.repeat(128),
        });
    });

    it('exposes locale/theme normalizers for shared callers', () => {
        expect(normalizeTheme('dark')).toBe('dark');
        expect(normalizeTheme('contrast')).toBe('light');
        expect(normalizeLocale('ru')).toBe('ru');
        expect(normalizeLocale('xx')).toBe('en');
    });
});
