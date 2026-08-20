import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DEFAULT_SETTINGS } from '@contracts/settings';
import {
    BROWSER_SETTINGS_COOKIE_KEY,
    parseBrowserSettingsPayload,
    readBrowserPerformanceModeSnapshot,
    serializeBrowserSettingsPayload,
} from '@app/utils/browserSettingsPersistence';
import { BROWSER_SETTINGS_STORAGE_KEY } from '@app/utils/browserRuntimePersistence';

function expectedLegacySettingsCookieExpiry(secure = false) {
    return `${BROWSER_SETTINGS_COOKIE_KEY}=; Path=/; Max-Age=0; SameSite=Lax${secure ? '; Secure' : ''}`;
}

function stubBrowserPersistence(options: {
    cookieValue?: string;
    protocol?: 'http:' | 'https:';
    storageValue?: string;
    throwOnSet?: boolean;
} = {}) {
    const storage = new Map<string, string>();
    if (options.storageValue !== undefined) {
        storage.set(BROWSER_SETTINGS_STORAGE_KEY, options.storageValue);
    }
    const cookieWrites: string[] = [];
    vi.stubGlobal('window', {localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
            if (options.throwOnSet) {
                throw new Error('storage unavailable');
            }
            storage.set(key, value);
        },
    }});
    vi.stubGlobal('location', {protocol: options.protocol ?? 'http:'});
    vi.stubGlobal('document', {
        get cookie() {
            return options.cookieValue === undefined
                ? ''
                : `${BROWSER_SETTINGS_COOKIE_KEY}=${encodeURIComponent(options.cookieValue)}`;
        },
        set cookie(value: string) { cookieWrites.push(value); },
    });
    return {
        cookieWrites,
        storage,
    };
}

describe('browserSettingsPersistence performanceMode', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('round-trips performanceMode through the legacy payload parser', () => {
        const serialized = serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode: 'high',
        });
        expect(parseBrowserSettingsPayload(serialized).performanceMode).toBe('high');
    });

    it('sanitizes an invalid persisted performanceMode back to auto', () => {
        expect(parseBrowserSettingsPayload(JSON.stringify({ performanceMode: 'turbo' })).performanceMode)
            .toBe('auto');
    });

    it('prefers a valid legacy cookie over divergent local storage and replaces storage', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload({
                ...DEFAULT_SETTINGS,
                performanceMode: 'low',
            }),
            storageValue: JSON.stringify({
                ...DEFAULT_SETTINGS,
                performanceMode: 'medium',
            }),
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('low');
        expect(JSON.parse(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({performanceMode: 'low'});
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('does not treat valid JSON with the wrong storage shape as canonical', () => {
        stubBrowserPersistence({storageValue: JSON.stringify({})});

        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });

    it('falls back from wrong-shaped storage to a valid legacy cookie', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload({
                ...DEFAULT_SETTINGS,
                performanceMode: 'high',
            }),
            storageValue: JSON.stringify({}),
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('high');
        expect(JSON.parse(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({performanceMode: 'high'});
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('migrates a legacy full-settings cookie to local storage and expires it', () => {
        const browser = stubBrowserPersistence({cookieValue: serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode: 'medium',
        })});

        expect(readBrowserPerformanceModeSnapshot()).toBe('medium');
        expect(JSON.parse(browser.storage.get(BROWSER_SETTINGS_STORAGE_KEY) ?? 'null'))
            .toMatchObject({performanceMode: 'medium'});
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('adds Secure to legacy cookie expiry only over HTTPS', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload(DEFAULT_SETTINGS),
            protocol: 'https:',
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry(true)]);
    });

    it('expires the request cookie even when local storage migration fails', () => {
        const browser = stubBrowserPersistence({
            cookieValue: serializeBrowserSettingsPayload({
                ...DEFAULT_SETTINGS,
                performanceMode: 'low',
            }),
            throwOnSet: true,
        });

        expect(readBrowserPerformanceModeSnapshot()).toBe('low');
        expect(browser.cookieWrites).toEqual([expectedLegacySettingsCookieExpiry()]);
    });

    it('returns auto when no local or legacy snapshot exists', () => {
        stubBrowserPersistence();
        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });

    it('returns auto when browser globals are unavailable', () => {
        vi.stubGlobal('window', undefined);
        vi.stubGlobal('document', undefined);
        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });
});
