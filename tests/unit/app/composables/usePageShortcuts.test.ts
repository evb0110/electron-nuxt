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
    hasElectronAPI: vi.fn(),
}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));
vi.mock('@app/utils/electron', () => ({hasElectronAPI: mocks.hasElectronAPI}));

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
        pdfViewerRef: ref(null),
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
    };
}

describe('usePageShortcuts', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('window', {} as Window);
        mocks.hasElectronAPI.mockReturnValue(true);
    });

    it('registers listeners once and cleans up idempotently', async () => {
        const cleanupA = vi.fn();
        const cleanupB = vi.fn();
        mocks.useEventListener
            .mockReturnValueOnce(cleanupA)
            .mockReturnValueOnce(cleanupB);

        const { usePageShortcuts } = await import('@app/composables/usePageShortcuts');
        const shortcuts = usePageShortcuts(createDeps());

        shortcuts.setupShortcuts();
        shortcuts.setupShortcuts();

        expect(mocks.useEventListener).toHaveBeenCalledTimes(2);

        shortcuts.cleanupShortcuts();
        shortcuts.cleanupShortcuts();

        expect(cleanupA).toHaveBeenCalledTimes(1);
        expect(cleanupB).toHaveBeenCalledTimes(1);
    });

    it('skips setup when window is unavailable', async () => {
        vi.stubGlobal('window', undefined);
        const { usePageShortcuts } = await import('@app/composables/usePageShortcuts');
        const shortcuts = usePageShortcuts(createDeps());

        shortcuts.setupShortcuts();

        expect(mocks.useEventListener).not.toHaveBeenCalled();
    });

    it('handles browser zoom shortcuts when Electron API is unavailable', async () => {
        const handlers = new Map<string, (event: unknown) => void>();
        const cleanup = vi.fn();
        mocks.useEventListener.mockImplementation((_target, event, handler) => {
            handlers.set(String(event), handler as (event: unknown) => void);
            return cleanup;
        });
        mocks.hasElectronAPI.mockReturnValue(false);

        const deps = createDeps();
        const { usePageShortcuts } = await import('@app/composables/usePageShortcuts');
        const shortcuts = usePageShortcuts(deps);

        shortcuts.setupShortcuts();
        const keydown = handlers.get('keydown');
        expect(keydown).toBeTypeOf('function');

        const preventZoomIn = vi.fn();
        keydown?.(cast<KeyboardEvent>({
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
        keydown?.(cast<KeyboardEvent>({
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
        keydown?.(cast<KeyboardEvent>({
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

        shortcuts.cleanupShortcuts();
        expect(cleanup).toHaveBeenCalledTimes(2);
    });
});
