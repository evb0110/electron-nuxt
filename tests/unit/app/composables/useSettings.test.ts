import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import type { ISettingsData } from '@contracts/shared';
import { createElectronPlatformApiFixture } from '@tests/helpers/createElectronPlatformApiFixture';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';

const mockGet = vi.fn<() => Promise<ISettingsData>>();
const mockSave = vi.fn<(settings: Partial<ISettingsData>) => Promise<void>>();
const cookieStore = new Map<string, Ref<unknown>>();
const stateStore = new Map<string, Ref<unknown>>();
const mockPlatformApi = createElectronPlatformApiFixture({settings: {
    get: mockGet,
    save: mockSave,
}});

vi.mock('@app/utils/platform', () => ({ getPlatformAPI: () => mockPlatformApi }));

function installNuxtStateStubs() {
    installNuxtStateTestStubs(cookieStore, stateStore);
    vi.stubGlobal('toRaw', <T>(value: T) => value);
}

function createDeferred() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        resolve,
        reject,
    };
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
        await expect(save()).resolves.toBe(true);

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'fr' }));
    });

    it('falls back to default locale when saving invalid locale', async () => {
        const { useSettings } = await import('@app/composables/useSettings');
        const {
            settings,
            save,
        } = useSettings();

        Reflect.set(settings.value, 'locale', 'xx');
        await expect(save()).resolves.toBe(true);

        expect(mockSave).toHaveBeenCalledWith(expect.objectContaining({ locale: 'en' }));
    });

    it('sanitizes invalid loaded locale to default', async () => {
        mockGet.mockResolvedValue({
            version: 1,
            performanceMode: 'auto',
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
            performanceMode: 'auto',
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
            isSettingsSavePendingRetry,
            settings,
            save,
            settingsSaveError,
            settingsSaveStatus,
        } = useSettings();

        settings.value.locale = 'fr';
        await expect(save()).resolves.toBe(false);
        expect(mockSave).toHaveBeenCalledTimes(1);
        expect(settingsSaveStatus.value).toBe('retry-pending');
        expect(settingsSaveError.value).toBe('temporary failure');
        expect(isSettingsSavePendingRetry.value).toBe(true);

        settings.value.locale = 'de';
        await vi.advanceTimersByTimeAsync(1_000);

        expect(mockSave).toHaveBeenCalledTimes(2);
        expect(mockSave).toHaveBeenLastCalledWith(expect.objectContaining({ locale: 'de' }));
        expect(settingsSaveStatus.value).toBe('idle');
        expect(settingsSaveError.value).toBeNull();
        expect(isSettingsSavePendingRetry.value).toBe(false);
        vi.useRealTimers();
    });

    it('shares one in-flight save queue across settings composable callers', async () => {
        const firstSave = createDeferred();
        mockSave
            .mockImplementationOnce(() => firstSave.promise)
            .mockResolvedValue(undefined);

        const { useSettings } = await import('@app/composables/useSettings');
        const firstSettings = useSettings();
        const secondSettings = useSettings();

        firstSettings.settings.value.locale = 'fr';
        const firstSavePromise = firstSettings.save();
        await vi.waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));

        secondSettings.settings.value.theme = 'dark';
        const secondSavePromise = secondSettings.save();

        expect(mockSave).toHaveBeenCalledTimes(1);

        firstSave.resolve();
        await Promise.all([
            firstSavePromise,
            secondSavePromise,
        ]);

        expect(mockSave).toHaveBeenCalledTimes(2);
        expect(mockSave).toHaveBeenNthCalledWith(2, { theme: 'dark' });
    });
});
