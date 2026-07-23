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

function stubSettingsCookie(rawValue: string | null) {
    const cookie = rawValue === null
        ? ''
        : `${BROWSER_SETTINGS_COOKIE_KEY}=${encodeURIComponent(rawValue)}`;
    vi.stubGlobal('document', { cookie });
}

describe('browserSettingsPersistence performanceMode', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('serializes performanceMode into the cookie payload', () => {
        const serialized = serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode: 'low',
        });
        expect(JSON.parse(serialized)).toMatchObject({ performanceMode: 'low' });
    });

    it('round-trips performanceMode through parse', () => {
        const serialized = serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode: 'high',
        });
        expect(parseBrowserSettingsPayload(serialized).performanceMode).toBe('high');
    });

    it('sanitizes an invalid persisted performanceMode back to auto', () => {
        const serialized = JSON.stringify({ performanceMode: 'turbo' });
        expect(parseBrowserSettingsPayload(serialized).performanceMode).toBe('auto');
    });

    it('reads the performance mode synchronously from the settings cookie', () => {
        stubSettingsCookie(serializeBrowserSettingsPayload({
            ...DEFAULT_SETTINGS,
            performanceMode: 'medium',
        }));
        expect(readBrowserPerformanceModeSnapshot()).toBe('medium');
    });

    it('returns auto when the settings cookie is absent', () => {
        stubSettingsCookie(null);
        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });

    it('returns auto when document is unavailable', () => {
        vi.stubGlobal('document', undefined);
        expect(readBrowserPerformanceModeSnapshot()).toBe('auto');
    });
});
