// @vitest-environment happy-dom

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

function createMarkupElement() {
    const element = document.createElement('div');
    document.body.append(element);
    return element;
}

function mockUiManagerRef(uiManager: ReturnType<typeof createUiManager>) {
    return cast<ShallowRef<AnnotationEditorUIManager | null>>(shallowRef(uiManager));
}

function createToolStateOptions(uiManager: ReturnType<typeof createUiManager>, overrides: Record<string, unknown> = {}) {
    return {
        annotationUiManager: mockUiManagerRef(uiManager),
        currentPage: ref(1),
        annotationTool: computed(() => (overrides.tool as string) ?? 'none'),
        annotationKeepActive: computed(() => (overrides.keepActive as boolean) ?? false),
        annotationSettings: computed(() => createAnnotationSettings()),
        numPages: ref(10),
        getEditorIdentity: vi.fn(() => 'mock-identity'),
        getFreeTextResize: () => ({ patchResizableFreeTextEditors: vi.fn() }),
        emitAnnotationToolAutoReset: vi.fn(),
        ...overrides,
    };
}

interface IAnnotationToolStateTestManager {
    applyAnnotationSettings: (settings: IAnnotationSettings) => void;
    forgetMarkupSubtypeOverride: (annotationId: string) => void;
    getAnnotationMode: (tool: string) => number;
    getMarkupSubtypeHints: () => unknown[];
    getMarkupSubtypeOverrides: () => Map<string, unknown>;
    getSelectedTextMarkupAnnotationProperties: () => unknown;
    maybeAutoResetAnnotationTool: () => void;
    rememberMarkupSubtypeColorOverride: (annotationId: string, color: string) => void;
    resolveEditorMarkupSubtypeColor: (editor: unknown, subtype: string, pageIndex: number) => string;
    resolveEditorMarkupSubtypeOverride: (editor: unknown, pageIndex: number) => string | null;
    resolveHighlightColorForTool: (settings: IAnnotationSettings, tool: string) => string;
    resolveHighlightOpacityForTool: (settings: IAnnotationSettings, tool: string) => number;
    setAnnotationTool: (tool: string) => Promise<void>;
    setEditorMarkupSubtypeOverride: (
        editor: unknown,
        pageIndex: number,
        subtype: string,
        options?: { preferEditorColor?: boolean },
    ) => void;
    updateModeWithRetry: (uiManager: unknown, mode: number, pageNumber: number) => Promise<Error | null>;
    updateSelectedTextMarkupAnnotationColor: (color: string) => boolean;
    updateTextMarkupAnnotationColor: (editor: unknown, pageIndex: number, subtype: string, color: string) => boolean;
}

async function loadUseAnnotationToolState(): Promise<(options: unknown) => IAnnotationToolStateTestManager> {
    const module = await import('@app/modules/pdf-viewer/runtime/annotations/useAnnotationToolState');
    return module.useAnnotationToolState as (options: unknown) => IAnnotationToolStateTestManager;
}

describe('useAnnotationToolState', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.replaceChildren();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('retries mode switch once after waiting for editors', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const firstError = new Error('mode not ready');
        const uiManager = createUiManager({updateMode: vi.fn()
            .mockRejectedValueOnce(firstError)
            .mockResolvedValueOnce(undefined)});

        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { currentPage: ref(3) }));

        const expectedMode = manager.getAnnotationMode('text');
        const result = await manager.updateModeWithRetry(uiManager, expectedMode, 3);
        expect(result).toBeNull();
        expect(uiManager.updateMode).toHaveBeenCalledTimes(2);
        expect(uiManager.waitForEditorsRendered).toHaveBeenCalledWith(3);
    });

    it('returns retry error when second mode switch fails', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const retryError = new Error('still failing');
        const uiManager = createUiManager({
            updateMode: vi.fn()
                .mockRejectedValueOnce(new Error('initial failure'))
                .mockRejectedValueOnce(retryError),
            waitForEditorsRendered: vi.fn(async () => {
                throw new Error('wait failed');
            }),
        });

        const manager = useAnnotationToolState(createToolStateOptions(uiManager));

        const expectedMode = manager.getAnnotationMode('draw');
        const result = await manager.updateModeWithRetry(uiManager, expectedMode, 1);
        expect(result).toBe(retryError);
    });

    it('serializes rapid tool changes and applies only latest pending mode', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const uiManager = createUiManager();

        const manager = useAnnotationToolState(createToolStateOptions(uiManager));

        manager.applyAnnotationSettings(createAnnotationSettings());
        await Promise.all([
            manager.setAnnotationTool('text'),
            manager.setAnnotationTool('draw'),
        ]);

        expect(uiManager.updateMode).toHaveBeenCalledTimes(1);
        expect(uiManager.updateMode).toHaveBeenCalledWith(manager.getAnnotationMode('draw'));
    });

    it('auto-resets tool when keep-active is disabled', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const emitAnnotationToolAutoReset = vi.fn();
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
            tool: 'text',
            emitAnnotationToolAutoReset,
        }));

        manager.maybeAutoResetAnnotationTool();
        await Promise.resolve();

        expect(emitAnnotationToolAutoReset).toHaveBeenCalledTimes(1);
    });

    it('does not auto-reset explicit select mode', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const emitAnnotationToolAutoReset = vi.fn();
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
            tool: 'select',
            emitAnnotationToolAutoReset,
        }));

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
            const useAnnotationToolState = await loadUseAnnotationToolState();
            const emitAnnotationToolAutoReset = vi.fn();
            const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
                tool,
                emitAnnotationToolAutoReset,
            }));

            manager.maybeAutoResetAnnotationTool();
            await Promise.resolve();

            expect(emitAnnotationToolAutoReset).not.toHaveBeenCalled();
        },
    );

    it('uses an opaque preblended display color for text highlights', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const uiManager = createUiManager();
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { tool: 'highlight' }));

        manager.applyAnnotationSettings(createAnnotationSettings());

        expect(uiManager.updateParams).toHaveBeenCalledWith(6, '#ffff66');
        expect(manager.resolveHighlightOpacityForTool(createAnnotationSettings(), 'highlight')).toBe(1);
    });

    it('clears selected pdf.js editors before applying toolbar settings as future defaults', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const uiManager = createUiManager();
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { tool: 'underline' }));

        manager.applyAnnotationSettings(createAnnotationSettings());

        expect(uiManager.setActiveEditor).toHaveBeenCalledWith(null);
        expect(uiManager.unselectAll).toHaveBeenCalled();
        const setActiveCallOrder = uiManager.setActiveEditor.mock.invocationCallOrder[0] ?? 0;
        const updateParamsCallOrder = uiManager.updateParams.mock.invocationCallOrder[0] ?? 0;
        expect(setActiveCallOrder).toBeLessThan(updateParamsCallOrder);
    });

    it('updates underline toolbar color as a default without mutating stale selected editors', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
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
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, { tool: 'underline' }));

        manager.applyAnnotationSettings(createAnnotationSettings());

        expect(updateDefaultParams).toHaveBeenCalledWith(6, '#00ff00');
        expect(uiManager.updateParams).not.toHaveBeenCalledWith(6, '#00ff00');
        expect(selectedEditor.updateParams).not.toHaveBeenCalledWith(6, '#00ff00');
    });

    it('keeps each existing underline painted with its captured editor color when defaults change', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const settings = ref(createAnnotationSettings());
        const firstEditor = {
            id: 'underline-1',
            color: '#f59e0b',
            div: createMarkupElement(),
        };
        const secondEditor = {
            id: 'underline-2',
            color: '#22c55e',
            div: createMarkupElement(),
        };
        const uiManager = createUiManager({ getEditors: vi.fn(() => [
            firstEditor,
            secondEditor,
        ]) });
        const manager = useAnnotationToolState(createToolStateOptions(uiManager, {
            annotationSettings: settings,
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }));

        manager.setEditorMarkupSubtypeOverride(firstEditor, 0, 'Underline');
        manager.setEditorMarkupSubtypeOverride(secondEditor, 0, 'Underline');
        settings.value = {
            ...settings.value,
            underlineColor: '#3b82f6',
        };
        manager.applyAnnotationSettings(settings.value);

        expect(firstEditor.div.style.getPropertyValue('--pdf-markup-subtype-color')).toBe('#f59e0b');
        expect(secondEditor.div.style.getPropertyValue('--pdf-markup-subtype-color')).toBe('#22c55e');
    });

    it('updates selected highlights with an opaque display color and raw persisted color', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const highlightEditor = {
            id: 'highlight-1',
            color: '#ffff66',
            opacity: 1,
            isSelected: true,
            parentPageIndex: 0,
            div: createMarkupElement(),
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
        }));

        manager.setEditorMarkupSubtypeOverride(highlightEditor, 0, 'Highlight');
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
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const addChangedExistingAnnotation = vi.fn();
        const highlightEditor = {
            id: 'highlight-1',
            annotationElementId: '42R0',
            color: '#ffff66',
            opacity: 1,
            div: createMarkupElement(),
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
        }));

        expect(manager.updateTextMarkupAnnotationColor(
            highlightEditor,
            0,
            'Highlight',
            '#22c55e',
        )).toBe(true);

        expect(highlightEditor.addToAnnotationStorage).toHaveBeenCalledTimes(1);
        expect(addChangedExistingAnnotation).toHaveBeenCalledWith(highlightEditor);
    });

    it('reapplies underline presentation after PDF.js updates editor color', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const div = createMarkupElement();
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
        }));

        manager.setEditorMarkupSubtypeOverride(underlineEditor, 0, 'Underline');
        underlineEditor.onUpdatedColor.mockClear();
        underlineEditor.addToAnnotationStorage.mockClear();

        expect(manager.updateSelectedTextMarkupAnnotationColor('#ef4444')).toBe(true);
        expect(underlineEditor.onUpdatedColor).toHaveBeenCalledTimes(1);
        expect(underlineEditor.div.dataset.markupSubtypeColor).toBe('#ef4444');
        expect(underlineEditor.div.style.getPropertyValue('--pdf-markup-subtype-color')).toBe('#ef4444');
        expect(underlineEditor.addToAnnotationStorage).toHaveBeenCalledTimes(1);
    });

    it('stores raw highlight color for selection-created editors instead of the opaque display color', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const highlightEditor = {
            id: 'highlight-1',
            color: '#ffff66',
            opacity: 1,
            __evbSelectionText: 'selected text',
            div: createMarkupElement(),
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.04,
        };
        highlightEditor.div.classList.add('highlightEditor');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager(), {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'highlight',
        }));

        expect(manager.resolveEditorMarkupSubtypeColor(highlightEditor, 'Highlight', 0)).toBe('#ffff00');
        expect((highlightEditor as { __evbMarkupSubtypeColor?: string }).__evbMarkupSubtypeColor).toBe('#ffff00');
    });

    it('uses raw highlight settings for active-tool subtype overrides while keeping the visual color opaque', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const highlightEditor = {
            id: 'highlight-1',
            color: '#ffff66',
            opacity: 1,
            div: createMarkupElement(),
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
        }));

        manager.setEditorMarkupSubtypeOverride(
            highlightEditor,
            0,
            'Highlight',
            { preferEditorColor: false },
        );

        expect((highlightEditor as { __evbMarkupSubtypeColor?: string }).__evbMarkupSubtypeColor).toBe('#ffff00');
        expect(highlightEditor.color).toBe('#ffff66');
        expect(highlightEditor.opacity).toBe(1);
    });

    it('prefers materialized annotation colors over stale editor defaults', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const underlineEditor = {
            id: 'underline-1',
            annotationElementId: '42R0',
            color: '#ffd400',
            opacity: 1,
            div: createMarkupElement(),
        };
        underlineEditor.div.classList.add('highlightEditor');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager({ getEditors: vi.fn(() => [underlineEditor]) }), {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }));

        expect(manager.resolveEditorMarkupSubtypeColor(underlineEditor, 'Underline', 0)).toBe('#ffd400');

        manager.rememberMarkupSubtypeColorOverride('42R0', '#22c55e');

        expect(manager.resolveEditorMarkupSubtypeColor(underlineEditor, 'Underline', 0)).toBe('#22c55e');
        expect((underlineEditor as { __evbMarkupSubtypeColor?: string }).__evbMarkupSubtypeColor).toBe('#22c55e');
    });

    it('uses normalized materialized annotation ids for markup color overrides', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const underlineEditor = {
            id: 'underline-1',
            annotationElementId: '42R',
            color: '#ef4444',
            div: createMarkupElement(),
        };
        underlineEditor.div.classList.add('highlightEditor');
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager({ getEditors: vi.fn(() => [underlineEditor]) }), {
            getEditorIdentity: (editor: { id?: string }) => editor.id ?? 'missing-id',
            tool: 'underline',
        }));

        manager.rememberMarkupSubtypeColorOverride('42R0', '#3b82f6');

        expect(manager.resolveEditorMarkupSubtypeColor(underlineEditor, 'Underline', 0)).toBe('#3b82f6');
    });

    it('records the per-page text markup order for subtype geometry hints', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const highlightEditor = {
            id: 'highlight-1',
            div: createMarkupElement(),
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.05,
        };
        highlightEditor.div.classList.add('highlightEditor');
        const underlineEditor = {
            id: 'underline-1',
            div: createMarkupElement(),
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
        }));

        manager.setEditorMarkupSubtypeOverride(underlineEditor, 0, 'Underline');

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
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const underlineEditor = {
            id: 'underline-1',
            div: createMarkupElement(),
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
        }));

        manager.setEditorMarkupSubtypeOverride(underlineEditor, 0, 'Underline');
        uiManager.getEditors.mockReturnValue([]);

        expect(manager.getMarkupSubtypeHints()).toEqual([]);
    });

    it('clears stale ref overrides for materialized PDF annotations', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const underlineEditor = {
            id: 'underline-1',
            annotationElementId: '42R0',
            div: createMarkupElement(),
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
        }));

        manager.setEditorMarkupSubtypeOverride(underlineEditor, 0, 'Underline');
        manager.forgetMarkupSubtypeOverride('42R0');

        expect(manager.getMarkupSubtypeOverrides().has('42R0')).toBe(false);
        expect(manager.resolveEditorMarkupSubtypeOverride(underlineEditor, 0)).toBeNull();
        expect(manager.getMarkupSubtypeHints()).toEqual([]);
    });

    it('keeps underline and strikethrough colors/opacity literal', async () => {
        const useAnnotationToolState = await loadUseAnnotationToolState();
        const manager = useAnnotationToolState(createToolStateOptions(createUiManager()));
        const settings = createAnnotationSettings();

        expect(manager.resolveHighlightColorForTool(settings, 'underline')).toBe('#00ff00');
        expect(manager.resolveHighlightOpacityForTool(settings, 'underline')).toBe(0.7);
        expect(manager.resolveHighlightColorForTool(settings, 'strikethrough')).toBe('#ff0000');
        expect(manager.resolveHighlightOpacityForTool(settings, 'strikethrough')).toBe(0.8);
    });

    it('clips overlapping multi-line markup boxes into non-overlapping fragment bands', async () => {
        const { normalizeTextMarkupBoxesByLine } = await import('@app/modules/pdf-viewer/engine/text-markup-visual-model/normalizeTextMarkupBoxesByLine');
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
