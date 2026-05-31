import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createSSRApp,
    createRenderer,
    defineComponent,
    nextTick,
    ref,
} from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { cast } from '../../../../../helpers/cast';

const mocks = vi.hoisted(() => ({
    useEventListener: vi.fn(),
    shouldHandleRendererMenuAccelerators: vi.fn(),
    registerTabsMenuBindings: vi.fn(() => []),
    getPlatformAPI: vi.fn(() => ({})),
    shouldPreferDesktopPlatform: vi.fn(() => false),
    waitForDesktopPlatformBridge: vi.fn(async () => true),
    claimPendingExternalOpenPaths: vi.fn(async (): Promise<string[]> => []),
    notifyRendererReady: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));
vi.mock('@app/utils/platformShortcuts', () => ({shouldHandleRendererMenuAccelerators: mocks.shouldHandleRendererMenuAccelerators}));
vi.mock('@app/modules/workspace-shell/composables/tabsMenuBindings', () => ({registerTabsMenuBindings: mocks.registerTabsMenuBindings}));
vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: mocks.getPlatformAPI,
    shouldPreferDesktopPlatform: mocks.shouldPreferDesktopPlatform,
    waitForDesktopPlatformBridge: mocks.waitForDesktopPlatformBridge,
}));
vi.mock('@app/utils/platformWindowTabs', () => ({getWindowTabsCapability: () => ({
    claimPendingExternalOpenPaths: mocks.claimPendingExternalOpenPaths,
    notifyRendererReady: mocks.notifyRendererReady,
})}));

function createOptions() {
    const workspace = {
        handleSaveAs: vi.fn(),
        handleExportDocx: vi.fn(),
        handleUndo: vi.fn(),
        handleRedo: vi.fn(),
    };

    return {
        tabs: ref([{id: 'tab-1'}]),
        isStartupOpenClaimPending: ref(true),
        activeTabId: ref('tab-1'),
        activeWorkspace: ref(cast<IWorkspaceExpose>(workspace)),
        createTab: vi.fn(() => ({id: 'tab-2'})),
        activateTab: vi.fn(),
        handleCloseTab: vi.fn(),
        handleFallbackToolbarOpenFile: vi.fn(),
        openPathInAppropriateTab: vi.fn(),
        openPathsInAppropriateTab: vi.fn(),
        beginOpenPathsInAppropriateTab: vi.fn(),
        clearRecentFiles: vi.fn(),
        loadRecentFiles: vi.fn(),
        openSettings: vi.fn(),
        checkForUpdates: vi.fn(),
        splitEditor: vi.fn(),
        focusGroup: vi.fn(),
        moveActiveTab: vi.fn(),
        copyActiveTab: vi.fn(),
        handleWindowTabsAction: vi.fn(),
        workspace,
    };
}

let capturedKeydown: ((event: KeyboardEvent) => void) | undefined;

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
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        mocks.shouldPreferDesktopPlatform.mockReturnValue(false);
        mocks.waitForDesktopPlatformBridge.mockResolvedValue(true);
        mocks.claimPendingExternalOpenPaths.mockResolvedValue([]);
        mocks.useEventListener.mockImplementation((_target, event, listener) => {
            if (event === 'keydown') {
                capturedKeydown = listener;
            }
            return vi.fn();
        });
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
        options.beginOpenPathsInAppropriateTab = vi.fn(() => new Promise<void>((resolve) => {
            resolveStartupOpen = resolve;
        }));
        mocks.claimPendingExternalOpenPaths.mockResolvedValue(['/tmp/startup.pdf']);

        const unmount = await mountBindingsClient(options);
        await flushMountedStartupClaim();

        expect(options.beginOpenPathsInAppropriateTab).toHaveBeenCalledWith(['/tmp/startup.pdf']);
        expect(options.isStartupOpenClaimPending.value).toBe(true);
        expect(mocks.notifyRendererReady).not.toHaveBeenCalled();

        resolveStartupOpen?.();
        await flushMountedStartupClaim();

        expect(options.isStartupOpenClaimPending.value).toBe(false);
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
