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
        HIGHLIGHT_COLOR: 6,
        HIGHLIGHT_THICKNESS: 7,
        HIGHLIGHT_FREE: 8,
        HIGHLIGHT_SHOW_ALL: 9,
    },
}));

type TUiManagerLike = {
    updateMode: ReturnType<typeof vi.fn>;
    waitForEditorsRendered: ReturnType<typeof vi.fn>;
    updateParams: ReturnType<typeof vi.fn>;
    getEditors: ReturnType<typeof vi.fn>;
    setActiveEditor: ReturnType<typeof vi.fn>;
    unselectAll: ReturnType<typeof vi.fn>;
    hasSelection?: boolean;
    __evbUpdateDefaultParams?: ReturnType<typeof vi.fn>;
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
        setActiveEditor: vi.fn(),
        unselectAll: vi.fn(),
        ...overrides,
    };
}

class FakeStyleDeclaration {
    private readonly values = new Map<string, string>();

    setProperty(name: string, value: string) {
        this.values.set(name, value);
    }

    removeProperty(name: string) {
        this.values.delete(name);
    }

    getPropertyValue(name: string) {
        return this.values.get(name) ?? '';
    }
}

class FakeClassList {
    private readonly values = new Set<string>();

    add(...names: string[]) {
        names.forEach(name => this.values.add(name));
    }

    remove(...names: string[]) {
        names.forEach(name => this.values.delete(name));
    }

    [Symbol.iterator]() {
        return this.values[Symbol.iterator]();
    }
}

class FakeMarkupElement {
    readonly classList = new FakeClassList();
    readonly dataset: Record<string, string> = {};
    readonly style = new FakeStyleDeclaration();
    readonly isConnected = true;

    querySelector() {
        return null;
    }

    closest() {
        return null;
    }
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

    afterEach(() => {
        vi.unstubAllGlobals();
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

    it('does not auto-reset explicit select mode', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const emitAnnotationToolAutoReset = vi.fn();
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
            tool: 'select',
            emitAnnotationToolAutoReset,
        }) as never);

        manager.maybeAutoResetAnnotationTool();
        await Promise.resolve();

        expect(emitAnnotationToolAutoReset).not.toHaveBeenCalled();
    });

    it.each([
        'highlight',
        'underline',
        'strikethrough',
    ] as const)(
        'does not auto-reset selection-markup tool %s',
        async (tool) => {
            const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
            const emitAnnotationToolAutoReset = vi.fn();
            const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
                tool,
                emitAnnotationToolAutoReset,
            }) as never);

            manager.maybeAutoResetAnnotationTool();
            await Promise.resolve();

            expect(emitAnnotationToolAutoReset).not.toHaveBeenCalled();
        },
    );

    it('keeps idle mode at none even when annotation cursor mode is enabled', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const manager = useAnnotationToolState(createToolStateOptions(
            createUiManager(),
            { annotationCursorMode: computed(() => true) },
        ) as never);

        expect(manager.getAnnotationMode('none')).toBe(0);
        expect(manager.getAnnotationMode('select')).toBe(0);
    });

    it('uses an opaque preblended display color for text highlights', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const uiManager = createUiManager();
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { tool: 'highlight' }) as never);

        manager.applyAnnotationSettings(createAnnotationSettings());

        expect(uiManager.updateParams).toHaveBeenCalledWith(6, '#ffff66');
        expect(manager.resolveHighlightOpacityForTool(createAnnotationSettings(), 'highlight')).toBe(1);
    });

    it('clears selected pdf.js editors before applying toolbar settings as future defaults', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const uiManager = createUiManager();
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { tool: 'underline' }) as never);

        manager.applyAnnotationSettings(createAnnotationSettings());

        expect(uiManager.setActiveEditor).toHaveBeenCalledWith(null);
        expect(uiManager.unselectAll).toHaveBeenCalled();
        const setActiveCallOrder = uiManager.setActiveEditor.mock.invocationCallOrder[0] ?? 0;
        const updateParamsCallOrder = uiManager.updateParams.mock.invocationCallOrder[0] ?? 0;
        expect(setActiveCallOrder).toBeLessThan(updateParamsCallOrder);
    });

    it('updates underline toolbar color as a default without mutating stale selected editors', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const selectedEditor = { updateParams: vi.fn() };
        const updateDefaultParams = vi.fn(() => true);
        const uiManager = createUiManager({
            hasSelection: true,
            __evbUpdateDefaultParams: updateDefaultParams,
            updateParams: vi.fn((type: number, value: unknown) => {
                if (type !== 9) {
                    selectedEditor.updateParams(type, value);
                }
            }),
        });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { tool: 'underline' }) as never);

        manager.applyAnnotationSettings(createAnnotationSettings());

        expect(updateDefaultParams).toHaveBeenCalledWith(6, '#00ff00');
        expect(uiManager.updateParams).not.toHaveBeenCalledWith(6, '#00ff00');
        expect(selectedEditor.updateParams).not.toHaveBeenCalledWith(6, '#00ff00');
    });

    it('keeps each existing underline painted with its captured editor color when defaults change', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const settings = ref(createAnnotationSettings());
        const firstEditor = {
            id: 'underline-1',
            color: '#f59e0b',
            div: new FakeMarkupElement(),
        };
        const secondEditor = {
            id: 'underline-2',
            color: '#22c55e',
            div: new FakeMarkupElement(),
        };
        const uiManager = createUiManager({ getEditors: vi.fn(() => [
            firstEditor,
            secondEditor,
        ]) });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            annotationSettings: settings,
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }) as never);

        manager.setEditorMarkupSubtypeOverride(firstEditor as never, 0, 'Underline');
        manager.setEditorMarkupSubtypeOverride(secondEditor as never, 0, 'Underline');
        settings.value = {
            ...settings.value,
            underlineColor: '#3b82f6',
        };
        manager.applyAnnotationSettings(settings.value);

        expect(firstEditor.div.style.getPropertyValue('--pdf-markup-subtype-color')).toBe('#f59e0b');
        expect(secondEditor.div.style.getPropertyValue('--pdf-markup-subtype-color')).toBe('#22c55e');
    });

    it('keeps underline and strikethrough colors/opacity literal', async () => {
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager()) as never);
        const settings = createAnnotationSettings();

        expect(manager.resolveHighlightColorForTool(settings, 'underline')).toBe('#00ff00');
        expect(manager.resolveHighlightOpacityForTool(settings, 'underline')).toBe(0.7);
        expect(manager.resolveHighlightColorForTool(settings, 'strikethrough')).toBe('#ff0000');
        expect(manager.resolveHighlightOpacityForTool(settings, 'strikethrough')).toBe(0.8);
    });
});
