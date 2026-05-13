import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createSSRApp,
    defineComponent,
    ref,
} from 'vue';
import { renderToString } from '@vue/server-renderer';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';

const mocks = vi.hoisted(() => ({
    useEventListener: vi.fn(),
    shouldHandleRendererMenuAccelerators: vi.fn(),
    registerTabsMenuBindings: vi.fn(() => []),
}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));
vi.mock('@app/utils/platformShortcuts', () => ({shouldHandleRendererMenuAccelerators: mocks.shouldHandleRendererMenuAccelerators}));
vi.mock('@app/modules/workspace-shell/composables/tabsMenuBindings', () => ({registerTabsMenuBindings: mocks.registerTabsMenuBindings}));

function cast<T>(obj: unknown): T {
    return obj as T;
}

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
        ensureAtLeastOneTab: vi.fn(),
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

describe('useTabsShellBindings', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        capturedKeydown = undefined;
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        mocks.useEventListener.mockImplementation((_target, event, listener) => {
            if (event === 'keydown') {
                capturedKeydown = listener;
            }
            return vi.fn();
        });
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
