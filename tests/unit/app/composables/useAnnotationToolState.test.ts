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
} from 'vue';
import type { ShallowRef } from 'vue';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationSettings } from '@app/types/annotations';
import { cast } from '@tests/helpers/cast';

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

interface IUiManagerLike {
    updateMode: ReturnType<typeof vi.fn>;
    waitForEditorsRendered: ReturnType<typeof vi.fn>;
    updateParams: ReturnType<typeof vi.fn>;
    getEditors: ReturnType<typeof vi.fn>;
    setActiveEditor: ReturnType<typeof vi.fn>;
    unselectAll: ReturnType<typeof vi.fn>;
    addChangedExistingAnnotation?: ReturnType<typeof vi.fn>;
    hasSelection?: boolean;
    __evbUpdateDefaultParams?: ReturnType<typeof vi.fn>;
}

function createAnnotationSettings(): IAnnotationSettings {
    return {
        highlightColor: '#ffff00',
        highlightOpacity: 0.6,
        highlightThickness: 12,
        highlightFreehandEnabled: false,
        showAllHighlights: true,
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

function createUiManager(overrides: Partial<IUiManagerLike> = {}) {
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

    contains(name: string) {
        return this.values.has(name);
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

    it('updates selected highlights with an opaque display color and raw persisted color', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const highlightEditor = {
            id: 'highlight-1',
            color: '#ffff66',
            opacity: 1,
            isSelected: true,
            parentPageIndex: 0,
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
            onUpdatedColor: vi.fn(),
            addToAnnotationStorage: vi.fn(),
        };
        highlightEditor.div.classList.add('highlightEditor');
        const uiManager = createUiManager({ getEditors: vi.fn(() => [highlightEditor]) });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'highlight',
        }) as never);

        manager.setEditorMarkupSubtypeOverride(highlightEditor as never, 0, 'Highlight');
        highlightEditor.onUpdatedColor.mockClear();
        highlightEditor.addToAnnotationStorage.mockClear();

        expect(manager.updateSelectedTextMarkupAnnotationColor('#336699')).toBe(true);
        expect(highlightEditor.color).toBe('#85a3c2');
        expect(highlightEditor.opacity).toBe(1);
        expect(highlightEditor.onUpdatedColor).toHaveBeenCalledTimes(1);
        expect(highlightEditor.addToAnnotationStorage).toHaveBeenCalledTimes(1);
        expect(manager.getSelectedTextMarkupAnnotationProperties()).toMatchObject({
            id: 'highlight-1',
            color: '#336699',
            subtype: 'Highlight',
        });
        expect(manager.getMarkupSubtypeHints()[0]).toMatchObject({
            id: 'highlight-1',
            color: '#336699',
            subtype: 'Highlight',
            pageIndex: 0,
            source: 'editor-live',
        });
    });

    it('marks existing materialized text markup as changed after color updates', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const addChangedExistingAnnotation = vi.fn();
        const highlightEditor = {
            id: 'highlight-1',
            annotationElementId: '42R0',
            color: '#ffff66',
            opacity: 1,
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
            onUpdatedColor: vi.fn(),
            addToAnnotationStorage: vi.fn(),
        };
        highlightEditor.div.classList.add('highlightEditor');
        const uiManager = createUiManager({
            addChangedExistingAnnotation,
            getEditors: vi.fn(() => [highlightEditor]),
        });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'highlight',
        }) as never);

        expect(manager.updateTextMarkupAnnotationColor(
            highlightEditor as never,
            0,
            'Highlight',
            '#22c55e',
        )).toBe(true);

        expect(highlightEditor.addToAnnotationStorage).toHaveBeenCalledTimes(1);
        expect(addChangedExistingAnnotation).toHaveBeenCalledWith(highlightEditor);
    });

    it('reapplies underline presentation after PDF.js updates editor color', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const div = new FakeMarkupElement();
        const underlineEditor = {
            id: 'underline-1',
            color: '#00ff00',
            isSelected: true,
            parentPageIndex: 0,
            div,
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
            onUpdatedColor: vi.fn(() => {
                div.dataset.markupSubtypeColor = '#111827';
                div.style.setProperty('--pdf-markup-subtype-color', '#111827');
            }),
            addToAnnotationStorage: vi.fn(),
        };
        underlineEditor.div.classList.add('highlightEditor');
        const uiManager = createUiManager({ getEditors: vi.fn(() => [underlineEditor]) });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }) as never);

        manager.setEditorMarkupSubtypeOverride(underlineEditor as never, 0, 'Underline');
        underlineEditor.onUpdatedColor.mockClear();
        underlineEditor.addToAnnotationStorage.mockClear();

        expect(manager.updateSelectedTextMarkupAnnotationColor('#ef4444')).toBe(true);
        expect(underlineEditor.onUpdatedColor).toHaveBeenCalledTimes(1);
        expect(underlineEditor.div.dataset.markupSubtypeColor).toBe('#ef4444');
        expect(underlineEditor.div.style.getPropertyValue('--pdf-markup-subtype-color')).toBe('#ef4444');
        expect(underlineEditor.addToAnnotationStorage).toHaveBeenCalledTimes(1);
    });

    it('stores raw highlight color for selection-created editors instead of the opaque display color', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const highlightEditor = {
            id: 'highlight-1',
            color: '#ffff66',
            opacity: 1,
            __evbSelectionText: 'selected text',
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
        };
        highlightEditor.div.classList.add('highlightEditor');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'highlight',
        }) as never);

        expect(manager.resolveEditorMarkupSubtypeColor(highlightEditor as never, 'Highlight', 0)).toBe('#ffff00');
        expect((highlightEditor as { __evbMarkupSubtypeColor?: string }).__evbMarkupSubtypeColor).toBe('#ffff00');
    });

    it('uses raw highlight settings for active-tool subtype overrides while keeping the visual color opaque', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const highlightEditor = {
            id: 'highlight-1',
            color: '#ffff66',
            opacity: 1,
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
            onUpdatedColor: vi.fn(),
            addToAnnotationStorage: vi.fn(),
        };
        highlightEditor.div.classList.add('highlightEditor');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'highlight',
        }) as never);

        manager.setEditorMarkupSubtypeOverride(
            highlightEditor as never,
            0,
            'Highlight',
            { preferEditorColor: false },
        );

        expect((highlightEditor as { __evbMarkupSubtypeColor?: string }).__evbMarkupSubtypeColor).toBe('#ffff00');
        expect(highlightEditor.color).toBe('#ffff66');
        expect(highlightEditor.opacity).toBe(1);
    });

    it('prefers materialized annotation colors over stale editor defaults', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const underlineEditor = {
            id: 'underline-1',
            annotationElementId: '42R0',
            color: '#ffd400',
            opacity: 1,
            div: new FakeMarkupElement(),
        };
        underlineEditor.div.classList.add('highlightEditor');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager({ getEditors: vi.fn(() => [underlineEditor]) }), {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }) as never);

        expect(manager.resolveEditorMarkupSubtypeColor(underlineEditor as never, 'Underline', 0)).toBe('#ffd400');

        manager.rememberMarkupSubtypeColorOverride('42R0', '#22c55e');

        expect(manager.resolveEditorMarkupSubtypeColor(underlineEditor as never, 'Underline', 0)).toBe('#22c55e');
        expect((underlineEditor as { __evbMarkupSubtypeColor?: string }).__evbMarkupSubtypeColor).toBe('#22c55e');
    });

    it('uses normalized materialized annotation ids for markup color overrides', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const underlineEditor = {
            id: 'underline-1',
            annotationElementId: '42R',
            color: '#ef4444',
            div: new FakeMarkupElement(),
        };
        underlineEditor.div.classList.add('highlightEditor');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager({ getEditors: vi.fn(() => [underlineEditor]) }), {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }) as never);

        manager.rememberMarkupSubtypeColorOverride('42R0', '#3b82f6');

        expect(manager.resolveEditorMarkupSubtypeColor(underlineEditor as never, 'Underline', 0)).toBe('#3b82f6');
    });

    it('records the per-page text markup order for subtype geometry hints', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const highlightEditor = {
            id: 'highlight-1',
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.05,
        };
        highlightEditor.div.classList.add('highlightEditor');
        const underlineEditor = {
            id: 'underline-1',
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.05,
        };
        underlineEditor.div.classList.add('highlightEditor');
        const uiManager = createUiManager({ getEditors: vi.fn(() => [
            highlightEditor,
            underlineEditor,
        ]) });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }) as never);

        manager.setEditorMarkupSubtypeOverride(underlineEditor as never, 0, 'Underline');

        const hints = manager.getMarkupSubtypeHints();
        expect(hints).toHaveLength(1);
        expect(hints[0]).toMatchObject({
            id: 'underline-1',
            subtype: 'Underline',
            pageIndex: 0,
            pageMarkupIndex: 1,
            source: 'editor-live',
        });
    });

    it('drops subtype geometry hints for editors no longer present on the page', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const underlineEditor = {
            id: 'underline-1',
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.05,
        };
        underlineEditor.div.classList.add('highlightEditor');
        const uiManager = createUiManager({ getEditors: vi.fn(() => [underlineEditor]) });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }) as never);

        manager.setEditorMarkupSubtypeOverride(underlineEditor as never, 0, 'Underline');
        uiManager.getEditors.mockReturnValue([]);

        expect(manager.getMarkupSubtypeHints()).toEqual([]);
    });

    it('clears stale ref overrides for materialized PDF annotations', async () => {
        vi.stubGlobal('HTMLElement', FakeMarkupElement);
        const { useAnnotationToolState } = await import('@app/composables/pdf/annotations/useAnnotationToolState');
        const underlineEditor = {
            id: 'underline-1',
            annotationElementId: '42R0',
            div: new FakeMarkupElement(),
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.05,
        };
        underlineEditor.div.classList.add('highlightEditor');
        const uiManager = createUiManager({ getEditors: vi.fn(() => [underlineEditor]) });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }) as never);

        manager.setEditorMarkupSubtypeOverride(underlineEditor as never, 0, 'Underline');
        manager.forgetMarkupSubtypeOverride('42R0');

        expect(manager.getMarkupSubtypeOverrides().has('42R0')).toBe(false);
        expect(manager.resolveEditorMarkupSubtypeOverride(underlineEditor as never, 0)).toBeNull();
        expect(manager.getMarkupSubtypeHints()).toEqual([]);
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

    it('clips overlapping multi-line markup boxes into non-overlapping fragment bands', async () => {
        const { normalizeTextMarkupBoxesByLine } = await import('@app/utils/pdf-viewer/text-markup-visual-model/normalizeTextMarkupBoxesByLine');
        const boxes = [
            {
                x: 0.10,
                y: 0.10,
                width: 0.30,
                height: 0.20,
            },
            {
                x: 0.45,
                y: 0.105,
                width: 0.20,
                height: 0.19,
            },
            {
                x: 0.10,
                y: 0.22,
                width: 0.40,
                height: 0.20,
            },
        ];

        const normalized = normalizeTextMarkupBoxesByLine(boxes);

        expect(normalized).toHaveLength(3);
        expect(normalized[0]).toEqual(expect.objectContaining({
            x: boxes[0]!.x,
            width: boxes[0]!.width,
            y: 0.10,
        }));
        expect(normalized[1]).toEqual(expect.objectContaining({
            x: boxes[1]!.x,
            width: boxes[1]!.width,
            y: 0.10,
        }));
        expect(normalized[2]).toEqual(expect.objectContaining({
            x: boxes[2]!.x,
            width: boxes[2]!.width,
        }));
        expect(normalized[0]!.y + normalized[0]!.height).toBeCloseTo(normalized[2]!.y, 6);
        expect(normalized[1]!.y + normalized[1]!.height).toBeCloseTo(normalized[2]!.y, 6);
        expect(normalized[2]!.height).toBeLessThan(boxes[2]!.height);
        expect(boxes[0]!.height).toBe(0.20);
    });
});
