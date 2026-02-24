import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type { TAnnotationTool } from '@app/types/annotations';

const mocks = vi.hoisted(() => ({useEventListener: vi.fn()}));

vi.mock('@vueuse/core', () => ({useEventListener: mocks.useEventListener}));

function createDeps() {
    return {
        isActive: ref(true),
        pdfSrc: ref('/tmp/a.pdf'),
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
    };
}

describe('usePageShortcuts', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal('window', {} as Window);
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
});
