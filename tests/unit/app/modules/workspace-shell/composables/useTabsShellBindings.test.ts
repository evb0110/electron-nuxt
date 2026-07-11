import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createRenderer,
    createSSRApp,
    defineComponent,
    nextTick,
    ref,
} from 'vue';
import { renderToString } from '@vue/server-renderer';
import {
    createDefaultWorkspaceToolbarSnapshot,
    type IWorkspaceExpose,
    type IWorkspaceToolbarSnapshot,
} from '@app/types/workspaceExpose';
import { createWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({
    useEventListener: vi.fn(),
    shouldHandleRendererMenuAccelerators: vi.fn(),
    registerTabsMenuBindings: vi.fn(() => []),
    documentMenuCapability: {},
    settingsCapability: {},
    updatesCapability: {},
    djvuCapability: {},
    shouldPreferDesktopPlatform: vi.fn(() => false),
    waitForDesktopPlatformBridge: vi.fn(async () => true),
    claimPendingExternalOpenPaths: vi.fn(async (): Promise<string[]> => []),
    acknowledgePendingExternalOpenPaths: vi.fn(async () => {}),
    notifyRendererReady: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));
vi.mock('@app/utils/shouldHandleRendererMenuAccelerators', () => ({shouldHandleRendererMenuAccelerators: mocks.shouldHandleRendererMenuAccelerators}));
vi.mock('@app/modules/workspace-shell/menu/registerTabsMenuBindings', () => ({registerTabsMenuBindings: mocks.registerTabsMenuBindings}));
vi.mock('@app/utils/platform', () => ({
    shouldPreferDesktopPlatform: mocks.shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge: mocks.waitForDesktopPlatformBridge,
}));
vi.mock('@app/utils/platformDocuments', () => ({getDocumentMenuCapability: () => mocks.documentMenuCapability}));
vi.mock('@app/utils/getSettingsCapability', () => ({getSettingsCapability: () => mocks.settingsCapability}));
vi.mock('@app/utils/platformUpdates', () => ({getUpdatesCapability: () => mocks.updatesCapability}));
vi.mock('@app/utils/getDjvuCapability', () => ({getDjvuCapability: () => mocks.djvuCapability}));
vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({
    claimPendingExternalOpenPaths: mocks.claimPendingExternalOpenPaths,
    acknowledgePendingExternalOpenPaths: mocks.acknowledgePendingExternalOpenPaths,
    notifyRendererReady: mocks.notifyRendererReady,
})}));

function createOptions() {
    const toolbarSnapshot = createDefaultWorkspaceToolbarSnapshot();
    const workspace = {
        getAutomationStateSnapshot: vi.fn(() => ({
            annotationComments: [],
            annotationCommentsStatus: 'ready',
            annotationDirty: false,
            originalPath: null,
            sortedAnnotationNoteWindows: [],
            workingCopyPath: '/tmp/active.pdf',
        })),
        getToolbarSnapshot: vi.fn(() => toolbarSnapshot),
        handleSaveAs: vi.fn(),
        handleRepairSave: vi.fn(),
        handleExportDocx: vi.fn(),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
        waitForDocumentOpenSettled: vi.fn(async () => {}),
    };
    const activeWorkspace = ref(cast<IWorkspaceExpose>(workspace));

    return {
        tabs: ref([{
            id: 'tab-1',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        }]),
        workspaceRefs: ref(new Map<string, IWorkspaceExpose>([[
            'tab-1',
            activeWorkspace.value,
        ]])),
        documentRecordsByTabId: ref<Record<string, ReturnType<typeof createWorkspaceDocumentRecord>>>({'tab-1': createWorkspaceDocumentRecord({ toolbarSnapshot })}),
        isStartupOpenClaimPending: ref(true),
        activeTabId: ref('tab-1'),
        activeWorkspace,
        createTab: vi.fn(() => ({id: 'tab-2'})),
        activateTab: vi.fn(),
        handleCloseTab: vi.fn(),
        handleFallbackToolbarOpenFile: vi.fn(),
        openPathInAppropriateTab: vi.fn(),
        openPathsInAppropriateTab: vi.fn(),
        beginOpenPathsInAppropriateTab: vi.fn(),
        restoreWorkspaceCheckpointGraph: vi.fn(),
        openPathInReservedTab: vi.fn(),
        clearRecentFiles: vi.fn(),
        loadRecentFiles: vi.fn(),
        openSettings: vi.fn(),
        checkForUpdates: vi.fn(),
        splitEditor: vi.fn(),
        focusPane: vi.fn(),
        moveActiveTab: vi.fn(),
        copyActiveTab: vi.fn(),
        handleWindowTabsAction: vi.fn(),
        toggleAssistant: vi.fn(),
        workspace,
    };
}

function createWorkspaceForAutomation(snapshot: Partial<IWorkspaceToolbarSnapshot>) {
    return cast<IWorkspaceExpose>({
        getAutomationStateSnapshot: vi.fn(() => ({
            annotationComments: [],
            annotationCommentsStatus: 'ready',
            annotationDirty: false,
            originalPath: null,
            sortedAnnotationNoteWindows: [],
            workingCopyPath: `/tmp/page-${snapshot.currentPage ?? 1}.pdf`,
        })),
        getToolbarSnapshot: vi.fn(() => ({
            ...createDefaultWorkspaceToolbarSnapshot(),
            ...snapshot,
        })),
        handleUndo: vi.fn(),
        waitForDocumentOpenSettled: vi.fn(async () => {}),
    });
}

let capturedKeydown: ((event: KeyboardEvent) => void) | undefined;

class CustomEventStub<T = unknown> {
    readonly detail: T | null;
    readonly type: string;

    constructor(type: string, init?: CustomEventInit<T>) {
        this.type = type;
        this.detail = init?.detail ?? null;
    }
}

async function mountBindings(options: ReturnType<typeof createOptions>) {
    const { useTabsShellBindings } = await import('@app/modules/workspace-shell/composables/useTabsShellBindings');
    const app = createSSRApp(defineComponent({setup() {
        useTabsShellBindings(options);
        return () => null;
    }}));

    await renderToString(app);

    return () => {};
}

async function mountBindingsClient(options: ReturnType<typeof createOptions>) {
    const { useTabsShellBindings } = await import('@app/modules/workspace-shell/composables/useTabsShellBindings');
    const renderer = createRenderer<Record<string, unknown>, Record<string, unknown>>({
        createElement: type => ({type}),
        createText: text => ({text}),
        createComment: text => ({text}),
        setText: () => {},
        setElementText: () => {},
        patchProp: () => {},
        insert: () => {},
        remove: () => {},
        parentNode: () => null,
        nextSibling: () => null,
    });
    const app = renderer.createApp(defineComponent({setup() {
        useTabsShellBindings(options);
        return () => null;
    }}));
    const root = {};
    app.mount(root);
    await nextTick();

    return () => app.unmount();
}

async function flushMountedStartupClaim() {
    await Promise.resolve();
    await Promise.resolve();
    await nextTick();
}

describe('useTabsShellBindings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        capturedKeydown = undefined;
        vi.stubGlobal('window', { dispatchEvent: vi.fn() });
        vi.stubGlobal('CustomEvent', CustomEventStub);
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        mocks.shouldPreferDesktopPlatform.mockReturnValue(false);
        mocks.waitForDesktopPlatformBridge.mockResolvedValue(true);
        mocks.claimPendingExternalOpenPaths.mockResolvedValue([]);
        mocks.acknowledgePendingExternalOpenPaths.mockResolvedValue(undefined);
        mocks.useEventListener.mockImplementation((_target, event, listener) => {
            if (event === 'keydown') {
                capturedKeydown = listener;
            }
            return vi.fn();
        });
        if (typeof window !== 'undefined') {
            delete window.__allowRendererFileOpenForAutomation;
            delete window.__evbTestApi;
            delete window.__handleSave;
            delete window.__openFileDirect;
        }
    });

    it('keeps the stable automation API absent when automation hooks are unavailable', async () => {
        const options = createOptions();

        const unmount = await mountBindingsClient(options);

        expect(window.__evbTestApi).toBeUndefined();
        expect(window.__openFileDirect).not.toBe(options.openPathInAppropriateTab);
        await expect(window.__openFileDirect?.('/tmp/sample.pdf')).resolves.toBeUndefined();
        unmount();
    });

    it('installs and cleans up the stable test API in automation mode', async () => {
        window.__allowRendererFileOpenForAutomation = vi.fn(async () => true);
        const options = createOptions();
        options.openPathInAppropriateTab = vi.fn(async () => true);

        const unmount = await mountBindingsClient(options);
        const { emitAutomationEvent } = await import('@app/modules/workspace-shell/automation/automationReadinessEvents');
        const observedEvents: string[] = [];
        const stopObserving = window.__evbTestApi?.onAutomationEvent(event => {
            observedEvents.push(event.type);
        });
        const eventPromise = window.__evbTestApi?.waitForAutomationEvent('navigation-idle', event => event.detail.page === 3, 1_000);
        emitAutomationEvent('navigation-idle', {page: 3});

        await expect(window.__evbTestApi?.openFile('/tmp/sample.pdf')).resolves.toBe(true);
        expect(options.openPathInAppropriateTab).toHaveBeenCalledWith('/tmp/sample.pdf');
        expect(window.__evbTestApi?.getActiveTabId()).toBe('tab-1');
        expect(window.__evbTestApi?.getActiveToolbarSnapshot()?.currentPage).toBe(1);
        await expect(eventPromise).resolves.toMatchObject({
            detail: {page: 3},
            type: 'navigation-idle',
        });
        expect(window.__evbTestApi?.getAutomationEvents().at(-1)).toMatchObject({type: 'navigation-idle'});
        expect(observedEvents).toContain('navigation-idle');
        stopObserving?.();
        await expect(window.__evbTestApi?.waitForActiveDocumentOpenSettled()).resolves.toBe(true);

        unmount();

        expect(window.__evbTestApi).toBeUndefined();
        expect(window.__openFileDirect).toBeTypeOf('function');
        await expect(window.__openFileDirect?.('/tmp/sample.pdf')).resolves.toBe(false);
    });

    it('keeps direct-open dispatcher stable across shell binding remounts', async () => {
        const firstOptions = createOptions();
        firstOptions.openPathInAppropriateTab = vi.fn(async () => true);

        const unmountFirst = await mountBindingsClient(firstOptions);
        const dispatcher = window.__openFileDirect;

        expect(dispatcher).toBeTypeOf('function');
        await expect(dispatcher?.('/tmp/first.pdf')).resolves.toBe(true);
        expect(firstOptions.openPathInAppropriateTab).toHaveBeenCalledWith('/tmp/first.pdf');

        unmountFirst();

        expect(window.__openFileDirect).toBe(dispatcher);
        await expect(window.__openFileDirect?.('/tmp/unbound.pdf')).resolves.toBe(false);

        const secondOptions = createOptions();
        secondOptions.openPathInAppropriateTab = vi.fn(async () => true);
        const unmountSecond = await mountBindingsClient(secondOptions);

        expect(window.__openFileDirect).toBe(dispatcher);
        await expect(window.__openFileDirect?.('/tmp/second.pdf')).resolves.toBe(true);
        expect(secondOptions.openPathInAppropriateTab).toHaveBeenCalledWith('/tmp/second.pdf');

        unmountSecond();
    });

    it('reads the current active workspace through the automation API after tab changes', async () => {
        window.__allowRendererFileOpenForAutomation = vi.fn(async () => true);
        const options = createOptions();
        const secondWorkspace = createWorkspaceForAutomation({ currentPage: 7 });

        const unmount = await mountBindingsClient(options);
        const installedApi = window.__evbTestApi;

        expect(installedApi?.getActiveToolbarSnapshot()?.currentPage).toBe(1);

        options.tabs.value.push({
            id: 'tab-2',
            fileName: null,
            originalPath: null,
            isDirty: false,
            isDjvu: false,
        });
        options.activeTabId.value = 'tab-2';
        options.activeWorkspace.value = secondWorkspace;
        options.workspaceRefs.value.set('tab-2', secondWorkspace);
        options.documentRecordsByTabId.value = {
            ...options.documentRecordsByTabId.value,
            'tab-2': createWorkspaceDocumentRecord({toolbarSnapshot: {
                hasPdf: true,
                currentPage: 7,
                totalPages: 10,
            }}),
        };
        await nextTick();

        expect(installedApi?.getActiveTabId()).toBe('tab-2');
        expect(installedApi?.getActiveToolbarSnapshot()?.currentPage).toBe(7);
        await expect(installedApi?.callActiveWorkspaceCommand('handleUndo')).resolves.toEqual({
            called: true,
            value: null,
        });
        expect(secondWorkspace.handleUndo).toHaveBeenCalledOnce();
        await expect(installedApi?.callActiveWorkspaceCommand('workingCopyPath')).resolves.toEqual({
            called: false,
            value: null,
        });
        expect(installedApi?.readActiveWorkspaceStateValues(['workingCopyPath'])).toEqual({ workingCopyPath: '/tmp/page-7.pdf' });

        unmount();
    });

    it('settles startup open claim after mounted startup work', async () => {
        const options = createOptions();
        options.isStartupOpenClaimPending.value = false;

        const unmount = await mountBindingsClient(options);

        await flushMountedStartupClaim();
        expect(options.isStartupOpenClaimPending.value).toBe(false);
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        unmount();
    });

    it('waits for claimed startup external paths before notifying renderer readiness', async () => {
        const options = createOptions();
        let resolveStartupOpen: (() => void) | undefined;
        options.beginOpenPathsInAppropriateTab = vi.fn(() => new Promise<string[]>((resolve) => {
            resolveStartupOpen = () => resolve([]);
        }));
        mocks.claimPendingExternalOpenPaths.mockResolvedValue(['/tmp/startup.pdf']);

        const unmount = await mountBindingsClient(options);
        await flushMountedStartupClaim();

        expect(options.beginOpenPathsInAppropriateTab).toHaveBeenCalledWith(['/tmp/startup.pdf']);
        expect(options.isStartupOpenClaimPending.value).toBe(true);
        expect(mocks.notifyRendererReady).not.toHaveBeenCalled();
        expect(mocks.acknowledgePendingExternalOpenPaths).not.toHaveBeenCalled();

        resolveStartupOpen?.();
        await flushMountedStartupClaim();

        expect(mocks.acknowledgePendingExternalOpenPaths).toHaveBeenCalledWith([]);
        expect(options.isStartupOpenClaimPending.value).toBe(false);
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        unmount();
    });

    it('acknowledges failed startup external paths before renderer readiness', async () => {
        const options = createOptions();
        options.beginOpenPathsInAppropriateTab = vi.fn(async () => ['/tmp/missing.pdf']);
        mocks.claimPendingExternalOpenPaths.mockResolvedValue(['/tmp/missing.pdf']);

        const unmount = await mountBindingsClient(options);
        await flushMountedStartupClaim();

        expect(mocks.acknowledgePendingExternalOpenPaths).toHaveBeenCalledWith(['/tmp/missing.pdf']);
        expect(mocks.notifyRendererReady).toHaveBeenCalledOnce();
        unmount();
    });

    it('routes web renderer menu shortcuts that have no native browser menu', async () => {
        const options = createOptions();
        const unmount = await mountBindings(options);

        const cases = [
            {
                key: 'o',
                shiftKey: false,
                run: options.handleFallbackToolbarOpenFile,
            },
            {
                key: 's',
                shiftKey: true,
                run: options.workspace.handleSaveAs,
            },
            {
                key: 'e',
                shiftKey: true,
                run: options.workspace.handleExportDocx,
            },
            {
                key: 'z',
                shiftKey: false,
                run: options.workspace.handleUndo,
            },
            {
                key: 'z',
                shiftKey: true,
                run: options.workspace.handleRedo,
            },
            {
                key: 'y',
                shiftKey: false,
                run: options.workspace.handleRedo,
            },
        ];

        for (const shortcut of cases) {
            const preventDefault = vi.fn();
            const stopPropagation = vi.fn();
            const stopImmediatePropagation = vi.fn();
            capturedKeydown?.(cast<KeyboardEvent>({
                key: shortcut.key,
                metaKey: true,
                ctrlKey: false,
                altKey: false,
                shiftKey: shortcut.shiftKey,
                target: null,
                preventDefault,
                stopPropagation,
                stopImmediatePropagation,
            }));

            expect(preventDefault).toHaveBeenCalledOnce();
            expect(stopPropagation).toHaveBeenCalledOnce();
            expect(stopImmediatePropagation).toHaveBeenCalledOnce();
            expect(shortcut.run).toHaveBeenCalled();
        }

        unmount();
    });

    it('logs rejected renderer document shortcuts without leaking the rejection', async () => {
        const options = createOptions();
        options.handleFallbackToolbarOpenFile = vi.fn(async () => {
            throw new Error('picker failed');
        });
        const unmount = await mountBindings(options);
        const { BrowserLogger } = await import('@app/utils/browserLogger');
        const errorSpy = vi.spyOn(BrowserLogger, 'error').mockImplementation(() => {});

        capturedKeydown?.(cast<KeyboardEvent>({
            key: 'o',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault: vi.fn(),
            stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        }));
        await Promise.resolve();

        expect(options.handleFallbackToolbarOpenFile).toHaveBeenCalledOnce();
        expect(errorSpy).toHaveBeenCalledWith(
            'tabs-shell',
            'Renderer document shortcut failed: open-file',
            {
                category: 'user-visible-operation',
                error: expect.any(Error),
            },
        );

        unmount();
        errorSpy.mockRestore();
    });

    it('keeps text editing undo and redo in editable controls', async () => {
        const options = createOptions();
        const unmount = await mountBindings(options);

        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        const preventDefault = vi.fn();
        capturedKeydown?.(cast<KeyboardEvent>({
            key: 'z',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: fakeInput,
            preventDefault,
            stopPropagation: vi.fn(),
            stopImmediatePropagation: vi.fn(),
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(options.workspace.handleUndo).not.toHaveBeenCalled();
        unmount();
    });
});
