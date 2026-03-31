import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    ref,
    shallowRef,
    type ShallowRef,
} from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationSettings } from '@app/types/annotations';

function cast<T>(obj: unknown): T {
    return obj as T;
}

vi.mock('pdfjs-dist', () => ({
    AnnotationEditorType: {
        NONE: 0,
        FREETEXT: 1,
        INK: 2,
        STAMP: 3,
        POPUP: 4,
    },
    AnnotationEditorParamsType: {
        INK_COLOR: 1,
        INK_OPACITY: 2,
        INK_THICKNESS: 3,
        FREETEXT_COLOR: 4,
        FREETEXT_SIZE: 5,
    },
}));

type TUiManagerLike = {
    updateMode: ReturnType<typeof vi.fn>;
    waitForEditorsRendered: ReturnType<typeof vi.fn>;
    updateParams: ReturnType<typeof vi.fn>;
    getEditors: ReturnType<typeof vi.fn>;
};

function createAnnotationSettings(): IAnnotationSettings {
    return {
        highlightColor: '#ffff00',
        highlightOpacity: 0.6,
        highlightThickness: 12,
        highlightFree: false,
        highlightShowAll: true,
        underlineColor: '#00ff00',
        underlineOpacity: 0.7,
        strikethroughColor: '#ff0000',
        strikethroughOpacity: 0.8,
        squigglyColor: '#0000ff',
        squigglyOpacity: 0.5,
        inkColor: '#111111',
        inkOpacity: 0.9,
        inkThickness: 2,
        textColor: '#222222',
        textSize: 14,
        shapeColor: '#333333',
        shapeFillColor: '#444444',
        shapeOpacity: 0.4,
        shapeStrokeWidth: 3,
    };
}

function createUiManager(overrides: Partial<TUiManagerLike> = {}) {
    return {
        updateMode: vi.fn(async (_mode: number) => {}),
        waitForEditorsRendered: vi.fn(async (_pageNumber: number) => {}),
        updateParams: vi.fn(),
        getEditors: vi.fn(() => []),
        ...overrides,
    };
}

function mockUiManagerRef(uiManager: ReturnType<typeof createUiManager>) {
    return cast<ShallowRef<AnnotationEditorUIManager | null>>(shallowRef(uiManager));
}

function createToolStateOptions(uiManager: ReturnType<typeof createUiManager>, overrides: Record<string, unknown> = {}) {
    return {
        annotationUiManager: mockUiManagerRef(uiManager),
        currentPage: ref(1),
        annotationTool: computed(() => (overrides.tool as string) ?? 'none'),
        annotationCursorMode: computed(() => false),
        annotationKeepActive: computed(() => (overrides.keepActive as boolean) ?? false),
        annotationSettings: computed(() => createAnnotationSettings()),
        numPages: ref(10),
        getEditorIdentity: vi.fn(() => 'mock-identity'),
        getFreeTextResize: () => ({ patchResizableFreeTextEditors: vi.fn() }),
        emitAnnotationToolAutoReset: vi.fn(),
        ...overrides,
    };
}

describe('useAnnotationToolState', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('retries mode switch once after waiting for editors', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const firstError = new Error('mode not ready');
        const uiManager = createUiManager({updateMode: vi.fn()
            .mockRejectedValueOnce(firstError)
            .mockResolvedValueOnce(undefined)});

        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { currentPage: ref(3) }) as never);

        const expectedMode = manager.getAnnotationMode('text');
        const result = await manager.updateModeWithRetry(uiManager as never, expectedMode, 3);
        expect(result).toBeNull();
        expect(uiManager.updateMode).toHaveBeenCalledTimes(2);
        expect(uiManager.waitForEditorsRendered).toHaveBeenCalledWith(3);
    });

    it('returns retry error when second mode switch fails', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const retryError = new Error('still failing');
        const uiManager = createUiManager({
            updateMode: vi.fn()
                .mockRejectedValueOnce(new Error('initial failure'))
                .mockRejectedValueOnce(retryError),
            waitForEditorsRendered: vi.fn(async () => {
                throw new Error('wait failed');
            }),
        });

        const manager = useAnnotationToolState(createToolStateOptions(uiManager) as never);

        const expectedMode = manager.getAnnotationMode('draw');
        const result = await manager.updateModeWithRetry(uiManager as never, expectedMode, 1);
        expect(result).toBe(retryError);
    });

    it('serializes rapid tool changes and applies only latest pending mode', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const uiManager = createUiManager();

        const manager = useAnnotationToolState(createToolStateOptions(uiManager) as never);

        manager.applyAnnotationSettings(createAnnotationSettings());
        await Promise.all([
            manager.setAnnotationTool('text'),
            manager.setAnnotationTool('draw'),
        ]);

        expect(uiManager.updateMode).toHaveBeenCalledTimes(1);
        expect(uiManager.updateMode).toHaveBeenCalledWith(manager.getAnnotationMode('draw'));
    });

    it('auto-resets tool when keep-active is disabled', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const emitAnnotationToolAutoReset = vi.fn();
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
            tool: 'text',
            emitAnnotationToolAutoReset,
        }) as never);

        manager.maybeAutoResetAnnotationTool();
        await Promise.resolve();

        expect(emitAnnotationToolAutoReset).toHaveBeenCalledTimes(1);
    });

    it('keeps idle mode at none even when annotation cursor mode is enabled', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const manager = useAnnotationToolState(createToolStateOptions(
            createUiManager(),
            { annotationCursorMode: computed(() => true) },
        ) as never);

        expect(manager.getAnnotationMode('none')).toBe(0);
    });
});
