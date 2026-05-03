import {
    AnnotationEditorParamsType,
    AnnotationEditorType,
} from '@app/services/pdfjs/runtime-lib';
import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type {
    Ref,
    ShallowRef,
} from 'vue';
import { tryOnScopeDispose } from '@vueuse/core';
import type {
    IAnnotationSettings,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import {
    isAuthoringAnnotationTool,
    isSelectionMarkupTool,
    shouldForceTextMarkup,
    TOOL_TO_MARKUP_SUBTYPE,
} from '@app/composables/pdf/annotations/annotationRules';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    rectIoU,
    rectCenterDistance,
} from '@app/composables/pdf/annotationGeometry';
import {
    errorToLogText,
    toCssColor,
} from '@app/composables/pdf/annotationCssUtils';
import {
    clearSelectedEditorState,
    getEditorsOnPage,
    updateEditorDefaultParams,
} from '@app/services/pdfjs/annotationEditorAdapter';
import { BrowserLogger } from '@app/utils/browser-logger';

const MARKUP_EDITOR_CLASS_PREFIX = 'pdf-markup-subtype-';
const MARKUP_DRAW_LAYER_CLASS_PREFIX = 'pdf-markup-subtype-draw-';
const MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE = 40;
const OPAQUE_HIGHLIGHT_OPACITY = 1;

type TAnnotationEditorMode = Parameters<AnnotationEditorUIManager['updateMode']>[0];

const ANNOTATION_TOOL_MODES: Partial<Record<TAnnotationTool, TAnnotationEditorMode>> = {
    text: AnnotationEditorType.FREETEXT,
    stamp: AnnotationEditorType.STAMP,
};

interface IHighlightDrawLayerCandidate {
    distance: number;
    overlapScore: number;
    svg: SVGElement;
}

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
    let editorObjectMarkupSubtypeOverrides = new WeakMap<IPdfjsEditor, TMarkupSubtype>();
    let editorObjectMarkupSubtypeColorOverrides = new WeakMap<IPdfjsEditor, string>();
    let editorDrawLayerHighlightRefs = new WeakMap<IPdfjsEditor, SVGElement>();
    const markupSubtypeRetryTimers = new Set<ReturnType<typeof setTimeout>>();

    tryOnScopeDispose(() => {
        markupSubtypeRetryTimers.forEach(timer => clearTimeout(timer));
        markupSubtypeRetryTimers.clear();
    });

    function scheduleMarkupSubtypeRetry(run: () => void, delayMs: number) {
        const timer = setTimeout(() => {
            markupSubtypeRetryTimers.delete(timer);
            run();
        }, delayMs);
        markupSubtypeRetryTimers.add(timer);
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
        const normalizedOpacity = Math.min(1, Math.max(0, opacity));
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

    type THighlightEditorCtor = {
        _editorType?: number;
        _defaultOpacity?: number;
    };

    let highlightEditorClass: THighlightEditorCtor | null = null;

    function isHighlightEditorCtor(ctor: unknown): ctor is THighlightEditorCtor {
        if (!ctor) {
            return false;
        }
        const candidate = ctor as THighlightEditorCtor;
        return candidate._editorType === AnnotationEditorType.HIGHLIGHT
            && typeof candidate._defaultOpacity === 'number';
    }

    function captureHighlightEditorClassFromTypes(types: readonly unknown[]) {
        if (highlightEditorClass) {
            return;
        }
        for (const type of types) {
            if (isHighlightEditorCtor(type)) {
                highlightEditorClass = type;
                const settings = pendingAnnotationSettings.value;
                if (settings) {
                    type._defaultOpacity = resolveHighlightOpacityForTool(settings, annotationTool.value);
                }
                return;
            }
        }
    }

    function tryCaptureHighlightEditorClassFromEditor(editor: IPdfjsEditor | null | undefined) {
        if (highlightEditorClass || !editor) {
            return;
        }
        const ctor = (editor as { constructor?: unknown }).constructor;
        if (isHighlightEditorCtor(ctor)) {
            highlightEditorClass = ctor;
        }
    }

    function syncHighlightDefaultOpacity(opacity: number) {
        if (highlightEditorClass) {
            highlightEditorClass._defaultOpacity = opacity;
        }
    }

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

    function enforceHighlightDefaultsForNewEditor(editor: IPdfjsEditor | null | undefined) {
        if (!editor) {
            return;
        }
        tryCaptureHighlightEditorClassFromEditor(editor);
        const ctor = (editor as { constructor?: { _editorType?: number } }).constructor;
        if (!ctor || ctor._editorType !== AnnotationEditorType.HIGHLIGHT) {
            return;
        }
        if (editor.annotationElementId) {
            return;
        }
        const settings = pendingAnnotationSettings.value;
        if (!settings) {
            return;
        }
        const opacity = resolveHighlightOpacityForTool(settings, annotationTool.value);
        syncHighlightDefaultOpacity(opacity);
        if (editor.opacity !== opacity) {
            (editor as { opacity?: number }).opacity = opacity;
            const onUpdatedColor = (editor as { onUpdatedColor?: () => void }).onUpdatedColor;
            if (typeof onUpdatedColor === 'function') {
                onUpdatedColor.call(editor);
            }
        }
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
                await uiManager.waitForEditorsRendered(Math.max(1, pageNumber));
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

    function resolveEditorHighlightClipPathId(editor: IPdfjsEditor) {
        const internal = editor.div?.querySelector<HTMLElement>('.internal');
        if (!internal) {
            return null;
        }
        const clipPath = internal.style.clipPath || getComputedStyle(internal).clipPath;
        const clipMatch = /#([A-Za-z0-9_-]+)/.exec(clipPath);
        return clipMatch?.[1] ?? null;
    }

    function isRenderableRect(rect: DOMRect) {
        return rect.width > 0 && rect.height > 0;
    }

    function toHighlightDrawLayerCandidate(editorRect: DOMRect, svg: SVGElement): IHighlightDrawLayerCandidate | null {
        const rect = svg.getBoundingClientRect();
        if (!isRenderableRect(rect)) {
            return null;
        }
        const overlapScore = rectIoU(editorRect, rect);
        return {
            distance: overlapScore > 0 ? 0 : rectCenterDistance(editorRect, rect),
            overlapScore,
            svg,
        };
    }

    function pickBetterHighlightDrawLayerCandidate(
        current: IHighlightDrawLayerCandidate | null,
        candidate: IHighlightDrawLayerCandidate,
    ) {
        if (!current) {
            return candidate;
        }
        if (current.overlapScore > 0 || candidate.overlapScore > 0) {
            return candidate.overlapScore > current.overlapScore ? candidate : current;
        }
        return candidate.distance < current.distance ? candidate : current;
    }

    function findClosestHighlightDrawLayerSvg(pageContainer: HTMLElement, editorDiv: HTMLElement) {
        const editorRect = editorDiv.getBoundingClientRect();
        if (!isRenderableRect(editorRect)) {
            return null;
        }
        const candidates = Array.from(pageContainer.querySelectorAll<SVGElement>('svg.highlight'));
        let bestCandidate: IHighlightDrawLayerCandidate | null = null;

        for (const candidate of candidates) {
            const scoredCandidate = toHighlightDrawLayerCandidate(editorRect, candidate);
            if (!scoredCandidate) {
                continue;
            }
            bestCandidate = pickBetterHighlightDrawLayerCandidate(bestCandidate, scoredCandidate);
        }

        if (
            bestCandidate
            && (
                bestCandidate.overlapScore > 0
                || bestCandidate.distance <= MAX_HIGHLIGHT_DRAW_LAYER_FALLBACK_DISTANCE
            )
        ) {
            return bestCandidate.svg;
        }
        return null;
    }

    function resolveEditorDrawLayerHighlight(editor: IPdfjsEditor) {
        const cached = editorDrawLayerHighlightRefs.get(editor);
        if (cached?.isConnected) {
            return cached;
        }
        const pageContainer = editor.div?.closest<HTMLElement>('.page_container');
        if (!pageContainer) {
            return null;
        }
        const clipPathId = resolveEditorHighlightClipPathId(editor);
        if (!clipPathId) {
            return null;
        }
        const escapedClipPathId = clipPathId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
        const clipPathNode = pageContainer.querySelector<SVGElement>(`svg.highlight clipPath[id="${escapedClipPathId}"]`);
        let highlightSvg = clipPathNode?.closest<SVGElement>('svg.highlight') ?? null;
        if (!highlightSvg && editor.div) {
            highlightSvg = findClosestHighlightDrawLayerSvg(pageContainer, editor.div);
        }
        if (highlightSvg) {
            editorDrawLayerHighlightRefs.set(editor, highlightSvg);
        }
        return highlightSvg;
    }

    function clearMarkupSubtypeDrawLayerClass(editor: IPdfjsEditor) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            return;
        }
        highlightSvg.classList.remove(
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}underline`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}strikeout`,
            `${MARKUP_DRAW_LAYER_CLASS_PREFIX}squiggly`,
        );
        highlightSvg.style.removeProperty('--pdf-markup-subtype-color');
    }

    function applyMarkupSubtypeDrawLayerClass(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        color: string | null,
        attempt = 0,
    ) {
        const highlightSvg = resolveEditorDrawLayerHighlight(editor);
        if (!highlightSvg) {
            if (attempt < 18 && editor.div?.isConnected) {
                scheduleMarkupSubtypeRetry(() => {
                    applyMarkupSubtypeDrawLayerClass(editor, subtype, color, attempt + 1);
                }, 50);
            }
            return;
        }
        clearMarkupSubtypeDrawLayerClass(editor);
        if (!subtype || subtype === 'Highlight') {
            return;
        }
        highlightSvg.classList.add(`${MARKUP_DRAW_LAYER_CLASS_PREFIX}${subtype.toLowerCase()}`);
        if (color) {
            highlightSvg.style.setProperty('--pdf-markup-subtype-color', color);
        }
    }

    function clearMarkupSubtypeEditorClass(editor: IPdfjsEditor) {
        const div = editor.div;
        if (!div) {
            clearMarkupSubtypeDrawLayerClass(editor);
            return;
        }
        div.classList.remove(
            `${MARKUP_EDITOR_CLASS_PREFIX}highlight`,
            `${MARKUP_EDITOR_CLASS_PREFIX}underline`,
            `${MARKUP_EDITOR_CLASS_PREFIX}strikeout`,
            `${MARKUP_EDITOR_CLASS_PREFIX}squiggly`,
        );
        delete div.dataset.markupSubtype;
        delete div.dataset.markupSubtypeColor;
        div.style.removeProperty('--pdf-markup-subtype-color');
        clearMarkupSubtypeDrawLayerClass(editor);
    }

    function applyEditorMarkupSubtypePresentation(
        editor: IPdfjsEditor,
        subtype: TMarkupSubtype | null,
        pageIndex = currentPage.value - 1,
    ) {
        const subtypeColor = subtype && subtype !== 'Highlight'
            ? resolveEditorMarkupSubtypeColor(editor, subtype, Math.max(0, pageIndex))
            : null;
        clearMarkupSubtypeEditorClass(editor);
        applyMarkupSubtypeDrawLayerClass(editor, subtype, subtypeColor);
        const div = editor.div;
        if (!div) {
            return;
        }
        if (!subtype || subtype === 'Highlight') {
            return;
        }
        const normalizedSubtype = subtype.toLowerCase();
        div.classList.add(`${MARKUP_EDITOR_CLASS_PREFIX}${normalizedSubtype}`);
        div.dataset.markupSubtype = normalizedSubtype;
        if (subtypeColor) {
            div.dataset.markupSubtypeColor = subtypeColor;
            div.style.setProperty('--pdf-markup-subtype-color', subtypeColor);
        }
    }

    function resolveEditorSubtypeFromPresentation(editor: IPdfjsEditor): TMarkupSubtype | null {
        const div = editor.div;
        if (!div) {
            return null;
        }
        const explicit = div.dataset.markupSubtype?.trim().toLowerCase() ?? '';
        if (explicit === 'underline') {
            return 'Underline';
        }
        if (explicit === 'strikeout' || explicit === 'strikethrough') {
            return 'StrikeOut';
        }
        if (explicit === 'squiggly') {
            return 'Squiggly';
        }
        if (explicit === 'highlight') {
            return 'Highlight';
        }

        const classList = Array.from(div.classList);
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}underline`))) {
            return 'Underline';
        }
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}strikeout`))) {
            return 'StrikeOut';
        }
        if (classList.some(name => name.includes(`${MARKUP_EDITOR_CLASS_PREFIX}squiggly`))) {
            return 'Squiggly';
        }
        return null;
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

    function clearOverrides() {
        markupSubtypeOverrides.clear();
        editorMarkupSubtypeOverrides.clear();
        markupSubtypeColorOverrides.clear();
        editorObjectMarkupSubtypeOverrides = new WeakMap();
        editorObjectMarkupSubtypeColorOverrides = new WeakMap();
        editorDrawLayerHighlightRefs = new WeakMap();
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
        markupSubtypeOverrides,
        clearOverrides,
    };
};
