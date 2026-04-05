import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdf';

const mocks = vi.hoisted(() => ({
    useEventListener: vi.fn(),
    useMagicKeys: vi.fn(),
    tryOnScopeDispose: vi.fn(),
    whenever: vi.fn(),
    hasElectronAPI: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({
    useEventListener: mocks.useEventListener,
    useMagicKeys: mocks.useMagicKeys,
    tryOnScopeDispose: mocks.tryOnScopeDispose,
    whenever: mocks.whenever,
}));
vi.mock('@app/utils/platform', () => ({hasElectronAPI: mocks.hasElectronAPI}));

function cast<T>(obj: unknown): T {
    return obj as T;
}

function createDeps() {
    return {
        isActive: ref(true),
        pdfSrc: ref<TPdfSource | null>(new Blob([], { type: 'application/pdf' })),
        showSettings: ref(false),
        annotationTool: ref<TAnnotationTool>('none'),
        annotationPlacingPageNote: ref(false),
        pdfViewerRef: ref({
            cancelCommentPlacement: vi.fn(),
            deleteSelectedShape: vi.fn(),
        }),
        shapePropertiesPopoverVisible: ref(false),
        annotationContextMenuVisible: ref(false),
        pageContextMenuVisible: ref(false),
        closeAnnotationContextMenu: vi.fn(),
        closePageContextMenu: vi.fn(),
        closeShapeProperties: vi.fn(),
        openSearch: vi.fn(),
        openAnnotations: vi.fn(),
        handleAnnotationToolChange: vi.fn(),
        handleZoomIn: vi.fn(),
        handleZoomOut: vi.fn(),
        handleActualSize: vi.fn(),
        handleSave: vi.fn(),
        handleToggleSidebar: vi.fn(),
    };
}

let capturedOnEventFired: ((e: unknown) => void) | undefined;

describe('usePageShortcuts', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('window', {
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        } as Window);
        mocks.hasElectronAPI.mockReturnValue(true);

        mocks.useMagicKeys.mockImplementation((opts?: { onEventFired?: (e: unknown) => void }) => {
            capturedOnEventFired = opts?.onEventFired;
            return new Proxy({}, { get: () => ref(false) });
        });
    });

    it('registers pointerdown listener on window', async () => {
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(createDeps());

        expect(window.addEventListener).toHaveBeenCalledWith(
            'pointerdown', expect.any(Function),
        );
    });

    it('skips pointerdown listener when window is unavailable', async () => {
        vi.stubGlobal('window', undefined);
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(createDeps());

        expect(mocks.useEventListener).not.toHaveBeenCalled();
    });

    it('handles zoom shortcuts via onEventFired when not Electron', async () => {
        mocks.hasElectronAPI.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventZoomIn = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '=',
            code: 'Equal',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventZoomIn,
        }));
        expect(preventZoomIn).toHaveBeenCalledOnce();
        expect(deps.handleZoomIn).toHaveBeenCalledOnce();

        const preventZoomOut = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '-',
            code: 'Minus',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventZoomOut,
        }));
        expect(preventZoomOut).toHaveBeenCalledOnce();
        expect(deps.handleZoomOut).toHaveBeenCalledOnce();

        const preventActualSize = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: '0',
            code: 'Digit0',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: preventActualSize,
        }));
        expect(preventActualSize).toHaveBeenCalledOnce();
        expect(deps.handleActualSize).toHaveBeenCalledOnce();
    });

    it('prevents default for Ctrl+B when active with PDF', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault,
        }));
        expect(preventDefault).toHaveBeenCalledOnce();
    });

    it('skips shortcuts when editing text', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        // Simulate an input element target using a minimal HTMLElement-like object
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'b',
            code: 'KeyB',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            target: fakeInput,
            preventDefault,
        }));
        expect(preventDefault).not.toHaveBeenCalled();
    });

    it('handles Escape to close context menus', async () => {
        const deps = createDeps();
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'Escape',
            code: 'Escape',
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault: vi.fn(),
        }));
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(deps.closePageContextMenu).toHaveBeenCalledOnce();
    });

    it('deletes the selected shape on Delete without modifiers', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'Delete',
            code: 'Delete',
            metaKey: false,
            ctrlKey: false,
            altKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(deps.pdfViewerRef.value?.deleteSelectedShape).toHaveBeenCalledOnce();
    });
});
