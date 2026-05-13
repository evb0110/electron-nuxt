import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    getDefaultBrowserOcrSettings,
    readBrowserOcrPreferences,
    sanitizeBrowserOcrSettings,
    saveBrowserOcrPreferences,
} from '@app/platform/browser-api/browserOcrPreferences';

describe('browser OCR preferences', () => {
    beforeEach(() => {
        const storage = new Map<string, string>();
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => {
                storage.set(key, value);
            },
        } });
    });

    it('returns sane defaults when settings are invalid', () => {
        expect(sanitizeBrowserOcrSettings({
            pageRange: 'bogus',
            customRange: 42,
            selectedLanguages: [],
        })).toEqual(getDefaultBrowserOcrSettings());
    });

    it('persists and reloads browser OCR preferences', () => {
        saveBrowserOcrPreferences({
            pageRange: 'custom',
            customRange: '2-4',
            selectedLanguages: [
                'eng',
                'deu',
            ],
        });

        expect(readBrowserOcrPreferences()).toEqual({
            pageRange: 'custom',
            customRange: '2-4',
            selectedLanguages: [
                'eng',
                'deu',
            ],
        });
    });

    it('falls back to null when stored data is malformed JSON', () => {
        const malformedStorage = new Map<string, string>([[
            'evb-viewer:browser:ocr-settings',
            '{bad-json',
        ]]);
        vi.stubGlobal('window', { localStorage: {
            getItem: (key: string) => malformedStorage.get(key) ?? null,
            setItem: vi.fn(),
        } });

        expect(readBrowserOcrPreferences()).toBeNull();
    });
});
