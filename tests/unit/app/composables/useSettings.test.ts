import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import type { ISettingsData } from '@contracts/shared';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const mockGet = vi.fn<() => Promise<ISettingsData>>();
const mockSave = vi.fn<(settings: ISettingsData) => Promise<void>>();
const cookieStore = new Map<string, Ref<unknown>>();
const stateStore = new Map<string, Ref<unknown>>();
const mockPlatformApi = { settings: {
    get: mockGet,
    save: mockSave,
} };

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

function installNuxtStateStubs() {
    installNuxtStateTestStubs(cookieStore, stateStore);
    vi.stubGlobal('toRaw', <T>(value: T) => value);
}

describe('useSettings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.useRealTimers();
        cookieStore.clear();
        stateStore.clear();
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
            uiScale: 'auto',
            tabMemoryPolicy: 'conservative',
            optimizePdfOnSaveAs: false,
            agentMcpEnabled: false,
            assistantPanelEnabled: false,
        });

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            load,
        } = useSettings();

        await load();

        expect(settings.value.locale).toBe('en');
    });

    it('starts unresolved without a snapshot and resolves after the authoritative load', async () => {
        mockGet.mockResolvedValue({
            version: 1,
            authorName: 'Browser Tester',
            theme: 'dark',
            locale: 'fr',
            defaultZoomPreset: 'fit-width',
            defaultViewMode: 'single',
            defaultContinuousScroll: true,
            defaultAnnotationColor: '#ffd400',
            uiScale: 'auto',
            tabMemoryPolicy: 'conservative',
            optimizePdfOnSaveAs: false,
            agentMcpEnabled: false,
            assistantPanelEnabled: false,
            suppressDefaultViewerPrompt: false,
            skippedUpdateVersion: undefined,
        });

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            isLoaded,
            load,
        } = useSettings();

        expect(isLoaded.value).toBe(false);

        await load();

        expect(isLoaded.value).toBe(true);
        expect(settings.value.theme).toBe('dark');
        expect(settings.value.locale).toBe('fr');
    });

    it('retries a failed settings save with the latest dirty payload', async () => {
        vi.useFakeTimers();
        mockSave
            .mockRejectedValueOnce(new Error('temporary failure'))
            .mockResolvedValue(undefined);

        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            save,
        } = useSettings();

        settings.value.locale = 'fr';
        await save();
        expect(mockSave).toHaveBeenCalledTimes(1);

        settings.value.locale = 'de';
        await vi.advanceTimersByTimeAsync(1_000);

        expect(mockSave).toHaveBeenCalledTimes(2);
        expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }));
        vi.useRealTimers();
    });
});
