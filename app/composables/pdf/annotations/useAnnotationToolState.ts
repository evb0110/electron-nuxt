import {
    AnnotationEditorParamsType,
    AnnotationEditorType,
} from '@app/services/pdfjs/runtimeLib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import type {
    IAnnotationMarkerRect,
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { IMarkupSubtypeHint } from '@app/composables/pdf/pdfSerializationSubtypeHints';
import {
    isAuthoringAnnotationTool,
    isSelectionMarkupTool,
    shouldForceTextMarkup,
    TOOL_TO_MARKUP_SUBTYPE,
} from '@app/composables/pdf/annotations/annotationRules';
import type {
    IPdfjsEditor,
    IPdfjsHighlightBox,
} from '@app/types/pdfjs';
import {
    errorToLogText,
    toCssColor,
} from '@app/composables/pdf/annotationCssUtils';
import { clamp } from 'es-toolkit/math';
import {
    clearSelectedEditorState,
    getEditorsOnPage,
    updateEditorDefaultParams,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { createPdfHighlightEditorClassPatch } from '@app/services/pdfjs/pdfHighlightEditorClassPatch';
import {
    createAnnotationMarkupSubtypeDrawLayer,
    findClosestHighlightDrawLayerSvg,
    resolveEditorHighlightClipPathId,
} from '@app/composables/pdf/annotations/annotationMarkupSubtypeDrawLayer';
import {
    createAnnotationEditorPresentation,
    normalizeMarkupSubtypeFragmentBoxes,
} from '@app/composables/pdf/annotations/annotationEditorPresentation';
import { BrowserLogger } from '@app/utils/browserLogger';

const ANNOTATION_MODE_RETRY_RENDER_WAIT_TIMEOUT_MS = 500;

const OPAQUE_HIGHLIGHT_OPACITY = 1;

type TAnnotationEditorMode = Parameters<AnnotationEditorUIManager['updateMode']>[0];

const ANNOTATION_TOOL_MODES: Partial<Record<TAnnotationTool, TAnnotationEditorMode>> = {
    text: AnnotationEditorType.FREETEXT,
    stamp: AnnotationEditorType.STAMP,
};

export { normalizeMarkupSubtypeFragmentBoxes };

interface IUseAnnotationToolStateOptions {
    annotationUiManager: ShallowRef<AnnotationEditorUIManager | null>;
    currentPage: Ref<number>;
    annotationTool: Ref<TAnnotationTool>;
    annotationCursorMode: Ref<boolean>;
    annotationKeepActive: Ref<boolean>;
    annotationSettings: Ref<IAnnotationSettings | null>;
    numPages: Ref<number>;
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string;
    getFreeTextResize: () => {patchResizableFreeTextEditors: (mgr: AnnotationEditorUIManager) => void;};
    emitAnnotationToolAutoReset: () => void;
}

export const useAnnotationToolState = (options: IUseAnnotationToolStateOptions) => {
    const {
        annotationUiManager,
        currentPage,
        annotationTool,
        annotationKeepActive,
        annotationSettings,
        numPages,
        getEditorIdentity,
        getFreeTextResize,
        emitAnnotationToolAutoReset,
    } = options;

    const pendingAnnotationTool = ref<TAnnotationTool>(annotationTool.value);
    const pendingAnnotationSettings = ref<IAnnotationSettings | null>(null);
    let annotationToolUpdateToken = 0;
    let annotationToolUpdatePromise: Promise<void> = Promise.resolve();

    const markupSubtypeOverrides = new Map<string, TMarkupSubtype>();
    const editorMarkupSubtypeOverrides = new Map<string, TMarkupSubtype>();
    const markupSubtypeColorOverrides = new Map<string, string>();
    const markupSubtypeGeometryHints = new Map<string, IMarkupSubtypeHint>();
    let editorObjectMarkupSubtypeOverrides = new WeakMap<IPdfjsEditor, TMarkupSubtype>();
    let editorObjectMarkupSubtypeColorOverrides = new WeakMap<IPdfjsEditor, string>();
    const markupSubtypeDrawLayer = createAnnotationMarkupSubtypeDrawLayer();
    const {
        resolveEditorDrawLayerHighlight,
        clearMarkupSubtypeDrawLayerClass,
        applyMarkupSubtypeDrawLayerClass,
    } = markupSubtypeDrawLayer;
    const {
        clearMarkupSubtypeEditorClass,
        applyEditorMarkupSubtypePresentation: applyEditorMarkupSubtypePresentationForPage,
        resolveEditorSubtypeFromPresentation,
    } = createAnnotationEditorPresentation({
        resolveEditorMarkupSubtypeHintRect,
        resolveEditorMarkupSubtypeColor,
        clearMarkupSubtypeDrawLayerClass,
        applyMarkupSubtypeDrawLayerClass,
    });

    function applyEditorMarkupSubtypePresentation(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        pageIndex = currentPage.value - 1,
    ) {
        applyEditorMarkupSubtypePresentationForPage(editor, subtype, pageIndex);
    }

    function isFinitePositiveRect(rect: IAnnotationMarkerRect | null | undefined): rect is IAnnotationMarkerRect {
        return Boolean(
            rect
            && Number.isFinite(rect.left)
            && Number.isFinite(rect.top)
            && Number.isFinite(rect.width)
            && Number.isFinite(rect.height)
            && rect.width > 0
            && rect.height > 0,
        );
    }

    function rectFromEditor(editor: IPdfjsEditor): IAnnotationMarkerRect | null {
        const rect = {
            left: editor.x ?? Number.NaN,
            top: editor.y ?? Number.NaN,
            width: editor.width ?? Number.NaN,
            height: editor.height ?? Number.NaN,
        };
        return isFinitePositiveRect(rect) ? rect : null;
    }

    function rectFromMarkupBoxes(boxes: readonly IPdfjsHighlightBox[] | null | undefined): IAnnotationMarkerRect | null {
        if (!boxes?.length) {
            return null;
        }
        let left = Number.POSITIVE_INFINITY;
        let top = Number.POSITIVE_INFINITY;
        let right = Number.NEGATIVE_INFINITY;
        let bottom = Number.NEGATIVE_INFINITY;

        for (const box of boxes) {
            if (
                !Number.isFinite(box.x)
                || !Number.isFinite(box.y)
                || !Number.isFinite(box.width)
                || !Number.isFinite(box.height)
                || box.width <= 0
                || box.height <= 0
            ) {
                continue;
            }
            left = Math.min(left, box.x);
            top = Math.min(top, box.y);
            right = Math.max(right, box.x + box.width);
            bottom = Math.max(bottom, box.y + box.height);
        }

        const rect = {
            left,
            top,
            width: right - left,
            height: bottom - top,
        };
        return isFinitePositiveRect(rect) ? rect : null;
    }

    function resolveEditorMarkupSubtypeHintRect(editor: IPdfjsEditor) {
        return rectFromEditor(editor) ?? rectFromMarkupBoxes(editor.__evbMarkupBoxes);
    }

    function getAnnotationMode(tool: TAnnotationTool) {
        return ANNOTATION_TOOL_MODES[tool] ?? AnnotationEditorType.NONE;
    }

    function resolveMarkupSubtypeColor(subtype: TMarkupSubtype) {
        const settings = annotationSettings.value;
        if (subtype === 'Underline') {
            return settings?.underlineColor ?? '#2563eb';
        }
        if (subtype === 'StrikeOut') {
            return settings?.strikethroughColor ?? '#dc2626';
        }
        return settings?.highlightColor ?? '#ffd400';
    }

    function resolveEditorColor(editor: IPdfjsEditor) {
        return toCssColor(editor.color, editor.opacity ?? 1);
    }

    function getEditorMarkupSubtypeColorKey(editor: IPdfjsEditor, pageIndex: number) {
        return getEditorIdentity(editor, pageIndex);
    }

    function storeEditorMarkupSubtypeColor(editor: IPdfjsEditor, pageIndex: number, color: string) {
        editor.__evbMarkupSubtypeColor = color;
        editorObjectMarkupSubtypeColorOverrides.set(editor, color);
        markupSubtypeColorOverrides.set(getEditorMarkupSubtypeColorKey(editor, pageIndex), color);
        if (editor.annotationElementId) {
            markupSubtypeColorOverrides.set(editor.annotationElementId, color);
        }
    }

    function resolveEditorMarkupSubtypeColor(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype,
        pageIndex: number,
    ) {
        const objectColor = editorObjectMarkupSubtypeColorOverrides.get(editor);
        if (objectColor) {
            return objectColor;
        }
        if (editor.__evbMarkupSubtypeColor) {
            return editor.__evbMarkupSubtypeColor;
        }
        const domColor = editor.div?.dataset.markupSubtypeColor;
        if (domColor) {
            storeEditorMarkupSubtypeColor(editor, pageIndex, domColor);
            return domColor;
        }
        if (editor.annotationElementId) {
            const annotationColor = markupSubtypeColorOverrides.get(editor.annotationElementId);
            if (annotationColor) {
                storeEditorMarkupSubtypeColor(editor, pageIndex, annotationColor);
                return annotationColor;
            }
        }
        const identityColor = markupSubtypeColorOverrides.get(getEditorMarkupSubtypeColorKey(editor, pageIndex));
        if (identityColor) {
            storeEditorMarkupSubtypeColor(editor, pageIndex, identityColor);
            return identityColor;
        }
        const editorColor = resolveEditorColor(editor);
        if (editorColor) {
            storeEditorMarkupSubtypeColor(editor, pageIndex, editorColor);
            return editorColor;
        }
        const fallbackColor = resolveMarkupSubtypeColor(subtype);
        storeEditorMarkupSubtypeColor(editor, pageIndex, fallbackColor);
        return fallbackColor;
    }

    function resolveHighlightColorForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        switch (tool) {
            case 'underline':
                return settings.underlineColor;
            case 'strikethrough':
                return settings.strikethroughColor;
            default:
                return settings.highlightColor;
        }
    }

    function toOpaqueHighlightDisplayColor(color: string, opacity: number) {
        const normalizedOpacity = clamp(opacity, 0, 1);
        const hexMatch = /^#(?<hex>[0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
        if (!hexMatch?.groups?.hex || normalizedOpacity >= 1) {
            return color;
        }

        const hex = hexMatch.groups.hex.length === 3
            ? hexMatch.groups.hex.split('').map(channel => channel + channel).join('')
            : hexMatch.groups.hex;
        const channels = [
            Number.parseInt(hex.slice(0, 2), 16),
            Number.parseInt(hex.slice(2, 4), 16),
            Number.parseInt(hex.slice(4, 6), 16),
        ];
        const blended = channels.map((channel) => {
            const value = Math.round(255 * (1 - normalizedOpacity) + channel * normalizedOpacity);
            return value.toString(16).padStart(2, '0');
        });
        return `#${blended.join('')}`;
    }

    function resolveHighlightDisplayColorForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        const color = resolveHighlightColorForTool(settings, tool);
        if (tool !== 'highlight') {
            return color;
        }
        return toOpaqueHighlightDisplayColor(color, settings.highlightOpacity);
    }

    function resolveHighlightOpacityForTool(settings: IAnnotationSettings, tool: TAnnotationTool): number {
        switch (tool) {
            case 'underline':
                return settings.underlineOpacity;
            case 'strikethrough':
                return settings.strikethroughOpacity;
            default:
                return OPAQUE_HIGHLIGHT_OPACITY;
        }
    }

    const {
        captureHighlightEditorClassFromTypes,
        syncHighlightDefaultOpacity,
        enforceHighlightDefaultsForNewEditor,
    } = createPdfHighlightEditorClassPatch({
        pendingAnnotationSettings,
        annotationTool,
        resolveHighlightOpacityForTool,
    });

    function resolveHighlightFreeForTool(settings: IAnnotationSettings, tool: TAnnotationTool) {
        if (shouldForceTextMarkup(tool)) {
            return false;
        }
        return settings.highlightFree;
    }

    function hasSelectedPdfjsEditor(uiManager: AnnotationEditorUIManager) {
        return Boolean((uiManager as AnnotationEditorUIManager & { hasSelection?: boolean }).hasSelection);
    }

    function applyToolbarDefaultParam(
        uiManager: AnnotationEditorUIManager,
        type: Parameters<AnnotationEditorUIManager['updateParams']>[0],
        value: Parameters<AnnotationEditorUIManager['updateParams']>[1],
    ) {
        if (updateEditorDefaultParams(uiManager, Number(type), value)) {
            return;
        }

        clearSelectedEditorState(uiManager);
        if (!hasSelectedPdfjsEditor(uiManager)) {
            uiManager.updateParams(type, value);
            return;
        }

        BrowserLogger.warn(
            'annotations',
            'Skipped toolbar default annotation parameter update because PDF.js kept a selected editor after clear.',
        );
    }

    function applyHighlightParamsForTool(
        uiManager: AnnotationEditorUIManager,
        settings: IAnnotationSettings,
        tool: TAnnotationTool,
    ) {
        syncHighlightDefaultOpacity(resolveHighlightOpacityForTool(settings, tool));
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.HIGHLIGHT_COLOR, resolveHighlightDisplayColorForTool(settings, tool));
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.HIGHLIGHT_THICKNESS, settings.highlightThickness);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.HIGHLIGHT_FREE, resolveHighlightFreeForTool(settings, tool));
        uiManager.updateParams(AnnotationEditorParamsType.HIGHLIGHT_SHOW_ALL, settings.highlightShowAll);
    }

    function applyAnnotationSettings(settings: IAnnotationSettings | null) {
        pendingAnnotationSettings.value = settings;
        const uiManager = annotationUiManager.value;
        if (!uiManager || !settings) {
            return;
        }

        const tool = annotationTool.value;
        applyHighlightParamsForTool(uiManager, settings, tool);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.INK_COLOR, settings.inkColor);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.INK_OPACITY, settings.inkOpacity);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.INK_THICKNESS, settings.inkThickness);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.FREETEXT_COLOR, settings.textColor);
        applyToolbarDefaultParam(uiManager, AnnotationEditorParamsType.FREETEXT_SIZE, settings.textSize);
        getFreeTextResize().patchResizableFreeTextEditors(uiManager);
        syncMarkupSubtypePresentationForEditors();
    }

    async function waitForEditorsRenderedBeforeModeRetry(
        uiManager: AnnotationEditorUIManager,
        pageNumber: number,
    ) {
        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                uiManager.waitForEditorsRendered(Math.max(1, pageNumber)),
                new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(() => {
                        reject(new Error('Timed out waiting for editors before annotation mode retry'));
                    }, ANNOTATION_MODE_RETRY_RENDER_WAIT_TIMEOUT_MS);
                }),
            ]);
        } finally {
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
        }
    }

    async function updateModeWithRetry(
        uiManager: AnnotationEditorUIManager,
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
        pageNumber = currentPage.value,
    ) {
        try {
            await uiManager.updateMode(mode);
            return null;
        } catch (initialError) {
            BrowserLogger.debug('annotations', `Annotation mode switch will retry: ${errorToLogText(initialError)}`);
            try {
                await waitForEditorsRenderedBeforeModeRetry(uiManager, pageNumber);
            } catch (waitError) {
                BrowserLogger.debug('annotations', `Failed to wait for editor render before mode retry: ${errorToLogText(waitError)}`);
            }
            await nextTick();
        }

        try {
            await uiManager.updateMode(mode);
            return null;
        } catch (retryError) {
            return retryError;
        }
    }

    function syncAnnotationEditorLayerVisibility(
        mode: Parameters<AnnotationEditorUIManager['updateMode']>[0],
    ) {
        if (typeof document === 'undefined' || mode === AnnotationEditorType.NONE) {
            return;
        }
        const layers = document.querySelectorAll<HTMLElement>(
            '.annotation-editor-layer, .annotationEditorLayer',
        );
        layers.forEach((layer) => {
            if (layer.hidden) {
                layer.hidden = false;
            }
        });
    }

    async function setAnnotationTool(tool: TAnnotationTool) {
        pendingAnnotationTool.value = tool;
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return;
        }
        const localToken = ++annotationToolUpdateToken;

        annotationToolUpdatePromise = annotationToolUpdatePromise.then(async () => {
            if (annotationToolUpdateToken !== localToken) {
                return;
            }

            const effectiveTool = pendingAnnotationTool.value;
            const mode = getAnnotationMode(effectiveTool);
            const settings = pendingAnnotationSettings.value;

            if (settings) {
                applyHighlightParamsForTool(uiManager, settings, effectiveTool);
            }

            const modeError = await updateModeWithRetry(uiManager, mode, currentPage.value);
            if (modeError) {
                BrowserLogger.warn('annotations', `Failed to update annotation tool mode: ${errorToLogText(modeError)}`);
                return;
            }

            syncAnnotationEditorLayerVisibility(mode);

            if (annotationToolUpdateToken !== localToken || !settings) {
                return;
            }

            applyAnnotationSettings(settings);
            getFreeTextResize().patchResizableFreeTextEditors(uiManager);
        }).catch((error: unknown) => {
            BrowserLogger.warn('annotations', 'Failed to apply annotation tool update', error);
        });

        await annotationToolUpdatePromise;
    }

    function getToolUpdatePromise() {
        return annotationToolUpdatePromise;
    }

    function maybeAutoResetAnnotationTool() {
        if (annotationKeepActive.value) {
            return;
        }
        if (!isAuthoringAnnotationTool(annotationTool.value)) {
            return;
        }
        // Selection-markup tools only fire when the user makes a text selection, so they cannot
        // misfire. Auto-resetting them to NONE hands pointer ownership to the annotation layer,
        // which blocks subsequent selections and turns the cursor into a pointer over saved
        // highlights. Keep them active across creations.
        if (isSelectionMarkupTool(annotationTool.value)) {
            return;
        }
        queueMicrotask(() => {
            emitAnnotationToolAutoReset();
        });
    }

    function syncMarkupSubtypePresentationForEditors() {
        const uiManager = annotationUiManager.value;
        if (!uiManager) {
            return;
        }
        for (let pageIndex = 0; pageIndex < numPages.value; pageIndex += 1) {
            for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
                const subtype = (
                    resolveEditorMarkupSubtypeOverride(normalizedEditor, pageIndex)
                    ?? resolveEditorSubtypeFromPresentation(normalizedEditor)
                );
                applyEditorMarkupSubtypePresentation(normalizedEditor, subtype, pageIndex);
            }
        }
    }

    function setEditorMarkupSubtypeOverride(editor: IPdfjsEditor, pageIndex: number, subtype: TMarkupSubtype) {
        editorObjectMarkupSubtypeOverrides.set(editor, subtype);
        const identity = getEditorIdentity(editor, pageIndex);
        editorMarkupSubtypeOverrides.set(identity, subtype);
        if (editor.annotationElementId) {
            markupSubtypeOverrides.set(editor.annotationElementId, subtype);
        }
        const markerRect = resolveEditorMarkupSubtypeHintRect(editor);
        if (markerRect) {
            markupSubtypeGeometryHints.set(identity, {
                subtype,
                pageIndex,
                markerRect,
                consumed: false,
            });
        }
        const color = resolveEditorColor(editor) ?? resolveMarkupSubtypeColor(subtype);
        storeEditorMarkupSubtypeColor(editor, pageIndex, color);
        applyEditorMarkupSubtypePresentation(editor, subtype, pageIndex);
    }

    function resolveEditorMarkupSubtypeOverride(editor: IPdfjsEditor, pageIndex: number): TMarkupSubtype | null {
        const byObject = editorObjectMarkupSubtypeOverrides.get(editor);
        if (byObject) {
            return byObject;
        }
        if (editor.annotationElementId) {
            const byAnnotationId = markupSubtypeOverrides.get(editor.annotationElementId);
            if (byAnnotationId) {
                return byAnnotationId;
            }
        }
        const identity = getEditorIdentity(editor, pageIndex);
        return editorMarkupSubtypeOverrides.get(identity) ?? null;
    }

    function getMarkupSubtypeOverrides() {
        return markupSubtypeOverrides;
    }

    function getMarkupSubtypeHints() {
        return Array.from(markupSubtypeGeometryHints.values()).map(hint => ({
            ...hint,
            markerRect: { ...hint.markerRect },
            consumed: false,
        }));
    }

    function clearOverrides() {
        markupSubtypeOverrides.clear();
        editorMarkupSubtypeOverrides.clear();
        markupSubtypeColorOverrides.clear();
        markupSubtypeGeometryHints.clear();
        editorObjectMarkupSubtypeOverrides = new WeakMap();
        editorObjectMarkupSubtypeColorOverrides = new WeakMap();
        markupSubtypeDrawLayer.clearDrawLayerState();
    }

    return {
        pendingAnnotationTool,
        pendingAnnotationSettings,
        TOOL_TO_MARKUP_SUBTYPE,
        isSelectionMarkupTool,
        shouldForceTextMarkup,
        getAnnotationMode,
        resolveMarkupSubtypeColor,
        resolveHighlightColorForTool,
        resolveHighlightOpacityForTool,
        resolveHighlightFreeForTool,
        applyHighlightParamsForTool,
        captureHighlightEditorClassFromTypes,
        enforceHighlightDefaultsForNewEditor,
        applyAnnotationSettings,
        setAnnotationTool,
        updateModeWithRetry,
        getToolUpdatePromise,
        maybeAutoResetAnnotationTool,
        resolveEditorHighlightClipPathId,
        resolveEditorDrawLayerHighlight,
        findClosestHighlightDrawLayerSvg,
        clearMarkupSubtypeEditorClass,
        applyEditorMarkupSubtypePresentation,
        resolveEditorSubtypeFromPresentation,
        syncMarkupSubtypePresentationForEditors,
        setEditorMarkupSubtypeOverride,
        resolveEditorMarkupSubtypeOverride,
        getMarkupSubtypeOverrides,
        getMarkupSubtypeHints,
        markupSubtypeOverrides,
        clearOverrides,
    };
};
