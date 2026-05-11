// PDF.js highlight editor private statics are intentionally patched here; re-audit on every pdfjs-dist upgrade.
import { AnnotationEditorType } from '@app/services/pdfjs/runtime-lib';
import type { Ref } from 'vue';
import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';

interface IHighlightEditorCtor {
    _editorType?: number;
    _defaultOpacity?: number;
}

function isHighlightEditorCtor(ctor: unknown): ctor is IHighlightEditorCtor {
    if (!ctor) {
        return false;
    }
    const candidate = ctor as IHighlightEditorCtor;
    return candidate._editorType === AnnotationEditorType.HIGHLIGHT
        && typeof candidate._defaultOpacity === 'number';
}

export function createPdfHighlightEditorClassPatch(options: {
    pendingAnnotationSettings: Ref<IAnnotationSettings | null>;
    annotationTool: Ref<TAnnotationTool>;
    resolveHighlightOpacityForTool: (settings: IAnnotationSettings, tool: TAnnotationTool) => number;
}) {
    let highlightEditorClass: IHighlightEditorCtor | null = null;

    function captureHighlightEditorClassFromTypes(types: readonly unknown[]) {
        if (highlightEditorClass) {
            return;
        }
        for (const type of types) {
            if (isHighlightEditorCtor(type)) {
                highlightEditorClass = type;
                const settings = options.pendingAnnotationSettings.value;
                if (settings) {
                    // PDF.js private static default; keeps new highlight editors aligned with current tool opacity.
                    type._defaultOpacity = options.resolveHighlightOpacityForTool(settings, options.annotationTool.value);
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
            // PDF.js private static default; keeps toolbar-created highlight editors consistent.
            highlightEditorClass._defaultOpacity = opacity;
        }
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
        const settings = options.pendingAnnotationSettings.value;
        if (!settings) {
            return;
        }
        const opacity = options.resolveHighlightOpacityForTool(settings, options.annotationTool.value);
        syncHighlightDefaultOpacity(opacity);
        if (editor.opacity !== opacity) {
            // PDF.js private editor field and callback; re-audit on pdfjs-dist upgrades.
            (editor as { opacity?: number }).opacity = opacity;
            const onUpdatedColor = (editor as { onUpdatedColor?: () => void }).onUpdatedColor;
            if (typeof onUpdatedColor === 'function') {
                onUpdatedColor.call(editor);
            }
        }
    }

    return {
        captureHighlightEditorClassFromTypes,
        syncHighlightDefaultOpacity,
        enforceHighlightDefaultsForNewEditor,
    };
}
