// @vitest-environment happy-dom

import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createApp,
    defineComponent,
    h,
    nextTick,
} from 'vue';
import {BrowserLogger} from '@app/utils/browserLogger';
import {createDefaultScanCleanupSettingsFile} from '@contracts/scanCleanupSettings';
import {useScanCleanupDocumentSettings} from '@app/modules/scan-cleanup/composables/useScanCleanupDocumentSettings';
import {discardScanCleanupDocumentState} from '@app/modules/scan-cleanup/runtime/discardScanCleanupDocumentState';
import {
    flushScanCleanupPreferencesStore,
    getScanCleanupPreferencesStore,
    loadScanCleanupDocumentSettings,
    resetScanCleanupPreferencesStore,
    saveScanCleanupDocumentPreferencesInStore,
    whenScanCleanupPreferencesReady,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreferencesStore';

const capability = vi.hoisted(() => ({value: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
}}));

vi.mock('@app/utils/platform', () => ({isDesktopPlatformActive: () => true}));
vi.mock('@app/utils/getScanCleanupCapability', () => ({getScanCleanupCapability: () => capability.value}));

describe('scan cleanup renderer preference store', () => {
    beforeEach(() => {
        resetScanCleanupPreferencesStore();
        localStorage.clear();
        vi.clearAllMocks();
        capability.value.getSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());
        capability.value.updateSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());
    });

    afterEach(() => {
        vi.useRealTimers();
        resetScanCleanupPreferencesStore();
    });

    it('persists a document patch under the normalized authoritative source hash', async () => {
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();

        saveScanCleanupDocumentPreferencesInStore(
            'A'.repeat(64),
            '/documents/book.pdf',
            {outputMode: 'grayscale'},
        );

        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledWith({document: {
            sourceSha256: 'a'.repeat(64),
            legacyDocumentKey: '/documents/book.pdf',
            patch: {outputMode: 'grayscale'},
        }}));
    });

    it('warns when a desktop document patch has no authoritative source hash', async () => {
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        const warning = vi.spyOn(BrowserLogger, 'warn');

        saveScanCleanupDocumentPreferencesInStore(null, '/documents/book.pdf', {outputMode: 'color'});
        await Promise.resolve();

        expect(capability.value.updateSettings).not.toHaveBeenCalled();
        expect(warning).toHaveBeenCalledWith(
            'scan-cleanup',
            expect.stringContaining('persist'),
            expect.any(Function),
        );
        warning.mockRestore();
    });

    it('keeps loaded document settings isolated from global preferences without echoing writes', async () => {
        vi.useFakeTimers();
        const sourceSha256 = 'b'.repeat(64);
        const documentKey = '/documents/stored-margins.pdf';
        const stored = createDefaultScanCleanupSettingsFile();
        stored.settings.readingOrder = 'rtl';
        stored.documentOverrides[sourceSha256] = {
            marginsMm: {
                leftMm: 12,
                topMm: 12,
                rightMm: 12,
                bottomMm: 12,
            },
            outputMode: 'color',
            overrides: {'1': {
                rotationDegrees: 90,
                layoutOverride: 'spread',
                excluded: false,
                manualSplit: null,
            }},
            lastUsedAtMs: 1,
        };
        capability.value.getSettings.mockResolvedValue(stored);
        capability.value.updateSettings.mockResolvedValue(stored);
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => `${documentKey}\0revision-1`),
                legacyDocumentKey: computed(() => documentKey),
                sourceSha256: computed(() => sourceSha256),
            });
            return () => h('div');
        }}));
        app.mount(host);

        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(settings!.values.marginsMm.topMm).toBe(12));
        await vi.advanceTimersByTimeAsync(350);

        expect(getScanCleanupPreferencesStore().marginsMm).toEqual({
            leftMm: 5,
            topMm: 5,
            rightMm: 5,
            bottomMm: 5,
        });
        const updates = capability.value.updateSettings.mock.calls.map(([request]) => request);
        expect(updates.filter(request => request.settings?.marginsMm !== undefined)).toEqual([]);
        expect(updates.filter(request => request.document !== undefined)).toEqual([]);
        app.unmount();
        host.remove();
    });

    it('exports legacy localStorage only for initial hydration and clears it after success', async () => {
        localStorage.setItem('evb.scanCleanup.settings.v1', JSON.stringify({readingOrder: 'rtl'}));
        localStorage.setItem('evb.scanCleanup.documentOverrides.v1', JSON.stringify({'/documents/legacy.pdf': {outputMode: 'color'}}));
        getScanCleanupPreferencesStore({
            sourceSha256: 'd'.repeat(64),
            legacyDocumentKey: '/documents/legacy.pdf',
        });

        await whenScanCleanupPreferencesReady();

        expect(capability.value.getSettings.mock.calls[0]?.[0]).toMatchObject({legacyStorage: {
            settingsRaw: JSON.stringify({readingOrder: 'rtl'}),
            documentOverridesRaw: JSON.stringify({'/documents/legacy.pdf': {outputMode: 'color'}}),
        }});
        expect(localStorage.getItem('evb.scanCleanup.settings.v1')).toBeNull();
        expect(localStorage.getItem('evb.scanCleanup.documentOverrides.v1')).toBeNull();

        await loadScanCleanupDocumentSettings('e'.repeat(64), '/documents/next.pdf');

        expect(capability.value.getSettings).toHaveBeenCalledTimes(2);
        expect(capability.value.getSettings.mock.calls[1]?.[0]).not.toHaveProperty('legacyStorage');
    });

    it('does not enqueue a pending global snapshot equal to the latest main-process value', async () => {
        const remote = createDefaultScanCleanupSettingsFile();
        getScanCleanupPreferencesStore();
        await whenScanCleanupPreferencesReady();
        capability.value.updateSettings.mockResolvedValue(remote);
        const preferences = getScanCleanupPreferencesStore();
        preferences.readingOrder = 'rtl';
        remote.settings.readingOrder = 'rtl';
        await nextTick();

        saveScanCleanupDocumentPreferencesInStore(
            'f'.repeat(64),
            '/documents/remote-snapshot.pdf',
            {outputMode: 'color'},
        );
        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalledWith({document: {
            sourceSha256: 'f'.repeat(64),
            legacyDocumentKey: '/documents/remote-snapshot.pdf',
            patch: {outputMode: 'color'},
        }}));
        await Promise.resolve();
        flushScanCleanupPreferencesStore();
        await Promise.resolve();

        const settingsUpdates = capability.value.updateSettings.mock.calls
            .map(([request]) => request)
            .filter(request => request.settings !== undefined);
        expect(settingsUpdates).toEqual([]);
    });

    it('does not flush a debounced override patch after document discard', async () => {
        const sourceSha256 = 'c'.repeat(64);
        const documentKey = '/documents/discard-after-edit.pdf';
        let settings: ReturnType<typeof useScanCleanupDocumentSettings> | null = null;
        const host = document.createElement('div');
        document.body.append(host);
        const app = createApp(defineComponent({setup() {
            settings = useScanCleanupDocumentSettings({
                documentLifecycleKey: computed(() => `${documentKey}\0revision-1`),
                legacyDocumentKey: computed(() => documentKey),
                sourceSha256: computed(() => sourceSha256),
            });
            return () => h('div');
        }}));
        app.mount(host);
        await whenScanCleanupPreferencesReady();
        await nextTick();
        vi.clearAllMocks();
        capability.value.updateSettings.mockResolvedValue(createDefaultScanCleanupSettingsFile());

        settings!.values.pageOverrides = {'1': {
            rotationDegrees: 90,
            layoutOverride: 'spread',
            excluded: false,
            manualSplit: null,
        }};
        await nextTick();
        discardScanCleanupDocumentState(documentKey, sourceSha256);
        app.unmount();
        host.remove();

        await vi.waitFor(() => expect(capability.value.updateSettings).toHaveBeenCalled());
        const documentUpdates = capability.value.updateSettings.mock.calls
            .map(([request]) => request)
            .filter(request => 'document' in request);
        expect(documentUpdates).toEqual([{document: {
            sourceSha256,
            legacyDocumentKey: documentKey,
            patch: {resetOverrides: true},
        }}]);
    });
});
