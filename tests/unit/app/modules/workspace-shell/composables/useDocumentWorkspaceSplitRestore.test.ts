import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    createRenderer,
    nextTick,
    ref,
    watch,
} from 'vue';
import type { Component } from 'vue';
import type { TSplitPayload } from '@contracts/windowTabs';

const mocks = vi.hoisted(() => ({
    cleanupSplitPayloadSnapshot: vi.fn(),
    loggerDebug: vi.fn(),
    loggerWarn: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/splits/cleanupSplitPayloadSnapshot', () => ({cleanupSplitPayloadSnapshot: mocks.cleanupSplitPayloadSnapshot}));

vi.mock('@app/utils/browserLogger', () => ({BrowserLogger: {
    debug: mocks.loggerDebug,
    warn: mocks.loggerWarn,
}}));

function installVueAutoImportStubs() {
    vi.stubGlobal('computed', computed);
    vi.stubGlobal('watch', watch);
}

function createNoopApp(component: Component) {
    const renderer = createRenderer<unknown, unknown>({
        patchProp: vi.fn(),
        insert: vi.fn(),
        remove: vi.fn(),
        createElement: vi.fn(() => ({})),
        createText: vi.fn(() => ({})),
        createComment: vi.fn(() => ({})),
        setText: vi.fn(),
        setElementText: vi.fn(),
        parentNode: vi.fn(() => null),
        nextSibling: vi.fn(() => null),
    });
    return renderer.createApp(component);
}

async function flushPromises() {
    await nextTick();
    await Promise.resolve();
    await Promise.resolve();
}

describe('useDocumentWorkspaceSplitRestore', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        installVueAutoImportStubs();
        mocks.cleanupSplitPayloadSnapshot.mockResolvedValue(true);
    });

    it('consumes and cleans up cached snapshot payloads after restore failure', async () => {
        const payload: TSplitPayload = {
            kind: 'pdfSnapshot',
            fileName: 'sample.pdf',
            originalPath: '/tmp/sample.pdf',
            snapshotPath: '/tmp/split-snapshot.pdf',
            isDirty: false,
            currentPage: 3,
            totalPages: 9,
        };
        let cachedPresent = true;
        const workspaceSplitCache = {
            has: vi.fn(() => cachedPresent),
            peek: vi.fn(() => ({
                id: 'entry-1',
                payload,
            })),
            consume: vi.fn(() => {
                cachedPresent = false;
                return payload;
            }),
            clear: vi.fn(),
            set: vi.fn(),
        };
        const restoreSplitPayload = vi.fn(async () => {
            throw new Error('restore failed');
        });
        const { useDocumentWorkspaceSplitRestore } = await import(
            '@app/modules/workspace-shell/composables/useDocumentWorkspaceSplitRestore'
        );

        const app = createNoopApp({setup() {
            useDocumentWorkspaceSplitRestore({
                tabId: 'tab-1',
                pendingDocumentOpen: computed(() => false),
                isTabTransitionBusy: computed(() => false),
                workspaceSplitCache,
                workspaceRestoreTracker: {
                    has: vi.fn(() => false),
                    start: vi.fn(),
                    finish: vi.fn(),
                },
                hasPdf: ref(false),
                currentPage: ref(1),
                totalPages: ref(0),
                showSidebar: ref(false),
                sidebarTab: ref(null),
                isResizingSidebar: ref(false),
                isLoading: ref(false),
                continuousScroll: ref(false),
                fitMode: ref(null),
                viewMode: ref(null),
                zoom: ref(1),
                pdfViewerRef: ref(null),
                initFromStorage: vi.fn(),
                cleanupSidebarResizeListeners: vi.fn(),
                captureSplitPayload: vi.fn(),
                restoreSplitPayload,
                isRestoringSplitPayload: ref(false),
                currentPageTransitionHistory: ref([]),
            });
            return () => null;
        }});

        app.mount({});
        await flushPromises();
        app.unmount();

        expect(restoreSplitPayload).toHaveBeenCalledWith(payload);
        expect(workspaceSplitCache.consume).toHaveBeenCalledWith('tab-1', 'entry-1');
        expect(mocks.cleanupSplitPayloadSnapshot).toHaveBeenCalledWith(payload, {
            logSection: 'workspace',
            context: 'failed-cached-split-restore',
            metadata: {
                tabId: 'tab-1',
                payloadKind: 'pdfSnapshot',
            },
        });
    });
});
