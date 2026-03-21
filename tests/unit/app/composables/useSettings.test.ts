import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { ISettingsData } from '@contracts/shared';

const mockGet = vi.fn<() => Promise<ISettingsData>>();
const mockSave = vi.fn<(settings: ISettingsData) => Promise<void>>();
const cookieStore = new Map<string, ReturnType<typeof ref>>();
const stateStore = new Map<string, ReturnType<typeof ref>>();

function installNuxtStateStubs() {
    vi.stubGlobal('useCookie', <T>(key: string, options?: { default?: () => T; }) => {
        const existing = cookieStore.get(key);
        if (existing) {
            return existing;
        }

        const cookie = ref(options?.default ? options.default() : null);
        cookieStore.set(key, cookie);
        return cookie;
    });

    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        const existing = stateStore.get(key);
        if (existing) {
            return existing;
        }

        const state = ref(init());
        stateStore.set(key, state);
        return state;
    });

    vi.stubGlobal('toRaw', <T>(value: T) => value);
}

function stubWindow() {
    vi.stubGlobal('window', {
        ...globalThis,
        electronAPI: { settings: {
            get: mockGet,
            save: mockSave,
        } },
    });
}

describe('useSettings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        cookieStore.clear();
        stateStore.clear();
        stubWindow();
        installNuxtStateStubs();
    });

    it('preserves supported locale values on save', async () => {
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            save,
        } = useSettings();

        settings.value.locale = 'fr';
        await save();

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }));
    });

    it('falls back to default locale when saving invalid locale', async () => {
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            save,
        } = useSettings();

        Reflect.set(settings.value, 'locale', 'xx');
        await save();

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }));
    });

    it('sanitizes invalid loaded locale to default', async () => {
        mockGet.mockResolvedValue({
            version: 1,
            authorName: 'Tester',
            theme: 'light',
            locale: 'xx' as ISettingsData['locale'],
            defaultZoomPreset: 'fit-width',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
            defaultAnnotationColor: '#ffd400',
        });

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            load,
        } = useSettings();

        await load();

        expect(settings.value.locale).toBe('en');
    });
});
