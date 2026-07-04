import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TAnnotationTool } from '@app/types/annotations';
import type { TPdfSource } from '@app/types/pdfUi';
import { cast } from '@tests/helpers/cast';

const mocks = vi.hoisted(() => ({
    useEventListener: vi.fn(),
    useMagicKeys: vi.fn(),
    tryOnScopeDispose: vi.fn(),
    whenever: vi.fn(),
    shouldHandleRendererMenuAccelerators: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({
    useEventListener: mocks.useEventListener,
    useMagicKeys: mocks.useMagicKeys,
    tryOnScopeDispose: mocks.tryOnScopeDispose,
    whenever: mocks.whenever,
}));
vi.mock('@app/utils/shouldHandleRendererMenuAccelerators', () => ({ shouldHandleRendererMenuAccelerators: mocks.shouldHandleRendererMenuAccelerators }));

function createDeps() {
    return {
        isActive: ref(true),
        pdfSrc: ref<TPdfSource | null>(new Blob([], { type: 'application/pdf' })),
        canPrint: ref(true),
        canSave: ref(true),
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
        handlePrint: vi.fn(),
        handleToggleSidebar: vi.fn(),
    };
}

let capturedOnEventFired: ((e: unknown) => void) | undefined;
let capturedPointerDown: ((e: PointerEvent) => void) | undefined;
let capturedKeyDown: ((e: KeyboardEvent) => void) | undefined;

describe('usePageShortcuts', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        const windowMock = {
            addEventListener: vi.fn((event: string, listener: EventListener) => {
                if (event === 'pointerdown') {
                    capturedPointerDown = listener;
                }
                if (event === 'keydown') {
                    capturedKeyDown = listener;
                }
            }),
            removeEventListener: vi.fn(),
        };
        vi.stubGlobal('window', windowMock);
        capturedPointerDown = undefined;
        capturedKeyDown = undefined;
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        mocks.useEventListener.mockImplementation((
            target: { addEventListener?: (...args: unknown[]) => void } | null,
            event: string,
            listener: EventListener,
            options?: AddEventListenerOptions,
        ) => {
            target?.addEventListener?.(event, listener, options);
            return vi.fn();
        });

        mocks.useMagicKeys.mockImplementation((opts?: { onEventFired?: (e: unknown) => void }) => {
            capturedOnEventFired = opts?.onEventFired;
            return new Proxy({}, { get: () => ref(false) });
        });
    });

    it('registers pointerdown listener on window', async () => {
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(createDeps());

        expect(mocks.useEventListener).toHaveBeenCalledWith(
            window, 'pointerdown', expect.any(Function),
        );
        expect(mocks.useEventListener).toHaveBeenCalledWith(
            window,
            'keydown', expect.any(Function), { capture: true },
        );
    });

    it('skips pointerdown listener when window is unavailable', async () => {
        vi.stubGlobal('window', undefined);
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(createDeps());

        expect(mocks.useEventListener).toHaveBeenCalledWith(
            null, 'pointerdown', expect.any(Function),
        );
        expect(mocks.useEventListener).toHaveBeenCalledWith(
            null, 'keydown', expect.any(Function), { capture: true },
        );
    });

    it('handles zoom shortcuts via onEventFired when not Electron', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
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

    it('intercepts Cmd/Ctrl+P in the web app and routes it to print', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handlePrint).toHaveBeenCalledOnce();
    });

    it('routes Cmd/Ctrl+P for printable non-PDF documents without pdfSrc', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        deps.pdfSrc.value = null;
        deps.canPrint.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handlePrint).toHaveBeenCalledOnce();
    });

    it('does not route Cmd/Ctrl+P when the active document cannot print', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        deps.canPrint.value = false;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handlePrint).not.toHaveBeenCalled();
    });

    it('intercepts Cmd/Ctrl+S in the web app and routes it to save', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('routes web Cmd/Ctrl+S to save while focus is inside editable annotation UI', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: fakeInput,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalled();
        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('captures web Cmd/Ctrl+S before editable controls can swallow it', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: { nodeName: 'TEXTAREA' },
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handleSave).toHaveBeenCalledOnce();
    });

    it('captures web Cmd/Ctrl+P before editable controls can swallow it', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: { nodeName: 'TEXTAREA' },
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handlePrint).toHaveBeenCalledOnce();
    });

    it('does not capture Cmd/Ctrl+S in Electron where the menu accelerator owns save', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();

        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: { nodeName: 'TEXTAREA' },
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(stopPropagation).not.toHaveBeenCalled();
        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('prevents browser save but skips app save when Cmd/Ctrl+S is disabled for a clean document', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(true);
        const deps = createDeps();
        deps.canSave.value = false;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const stopPropagation = vi.fn();
        capturedKeyDown?.(cast<KeyboardEvent>({
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
            stopPropagation,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(stopPropagation).toHaveBeenCalledOnce();
        expect(deps.handleSave).not.toHaveBeenCalled();
    });

    it('does not intercept Cmd/Ctrl+S in Electron where the menu accelerator owns save', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 's',
            code: 'KeyS',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.handleSave).not.toHaveBeenCalled();
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

    it('opens search for Cmd/Ctrl+F even when focus starts in an editable field', async () => {
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);

        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'f',
            code: 'KeyF',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: fakeInput,
            preventDefault,
        }));

        expect(preventDefault).toHaveBeenCalledOnce();
        expect(deps.openSearch).toHaveBeenCalledOnce();
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

    it('does not intercept Delete or Backspace inside editable fields', async () => {
        const deps = createDeps();
        const fakeInput = {
            isContentEditable: false,
            closest: (selector: string) => selector.includes('input') ? fakeInput : null,
        };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(fakeInput, HTMLElement.prototype);
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        for (const key of [
            'Delete',
            'Backspace',
        ]) {
            const preventDefault = vi.fn();
            capturedOnEventFired?.(cast<KeyboardEvent>({
                type: 'keydown',
                key,
                code: key,
                metaKey: false,
                ctrlKey: false,
                altKey: false,
                target: fakeInput,
                preventDefault,
            }));

            expect(preventDefault).not.toHaveBeenCalled();
        }
        expect(deps.pdfViewerRef.value?.deleteSelectedShape).not.toHaveBeenCalled();
    });

    it('ignores modified Alt shortcuts', async () => {
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
            altKey: true,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.handleToggleSidebar).not.toHaveBeenCalled();
    });

    it('does not route Cmd/Ctrl+P when renderer accelerators are delegated', async () => {
        mocks.shouldHandleRendererMenuAccelerators.mockReturnValue(false);
        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const preventDefault = vi.fn();
        capturedOnEventFired?.(cast<KeyboardEvent>({
            type: 'keydown',
            key: 'p',
            code: 'KeyP',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false,
            target: null,
            preventDefault,
        }));

        expect(preventDefault).not.toHaveBeenCalled();
        expect(deps.handlePrint).not.toHaveBeenCalled();
    });

    it('closes visible shortcut menus on outside pointerdown', async () => {
        const deps = createDeps();
        deps.shapePropertiesPopoverVisible.value = true;
        deps.annotationContextMenuVisible.value = true;
        deps.pageContextMenuVisible.value = true;
        const { usePageShortcuts } = await import('@app/modules/workspace-shell/composables/usePageShortcuts');
        usePageShortcuts(deps);

        const target = { closest: vi.fn(() => null) };
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        vi.stubGlobal('HTMLElement', class HTMLElementStub {});
        Object.setPrototypeOf(target, HTMLElement.prototype);

        capturedPointerDown?.(cast<PointerEvent>({target}));

        expect(deps.closeShapeProperties).toHaveBeenCalledOnce();
        expect(deps.closeAnnotationContextMenu).toHaveBeenCalledOnce();
        expect(deps.closePageContextMenu).toHaveBeenCalledOnce();
    });
});
