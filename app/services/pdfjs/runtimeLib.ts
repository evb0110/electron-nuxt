import { ensurePdfjsSsrGlobals } from '@app/services/pdfjs/ensurePdfjsSsrGlobals';

ensurePdfjsSsrGlobals();

const pdfjsLib = await import('pdfjs-dist');

type TPdfjsRuntimeLib = typeof pdfjsLib;

const DEFAULT_ANNOTATION_EDITOR_TYPE = {
    DISABLE: -1,
    NONE: 0,
    FREETEXT: 3,
    HIGHLIGHT: 9,
    STAMP: 13,
    INK: 15,
    POPUP: 16,
};

const DEFAULT_ANNOTATION_EDITOR_PARAMS_TYPE = {
    RESIZE: 1,
    CREATE: 2,
    FREETEXT_SIZE: 11,
    FREETEXT_COLOR: 12,
    INK_COLOR: 21,
    INK_THICKNESS: 22,
    INK_OPACITY: 23,
    HIGHLIGHT_COLOR: 31,
    HIGHLIGHT_THICKNESS: 32,
    HIGHLIGHT_FREE: 33,
    HIGHLIGHT_SHOW_ALL: 34,
    DRAW_STEP: 41,
};

const DEFAULT_ANNOTATION_MODE = {
    DISABLE: 0,
    ENABLE: 1,
    ENABLE_FORMS: 2,
    ENABLE_STORAGE: 3,
};

const DEFAULT_PIXELS_PER_INCH = {
    CSS: 96,
    PDF: 72,
    PDF_TO_CSS_UNITS: 96 / 72,
};

function getRuntimeExport<K extends keyof TPdfjsRuntimeLib>(
    name: K,
    fallback?: TPdfjsRuntimeLib[K],
) {
    return (name in pdfjsLib ? pdfjsLib[name] : fallback) as NonNullable<TPdfjsRuntimeLib[K]>;
}

function getMergedRuntimeExport<K extends keyof TPdfjsRuntimeLib, T extends Record<string, unknown>>(
    name: K,
    defaults: T,
) {
    const value = getRuntimeExport(name);
    return {
        ...defaults,
        ...(value && typeof value === 'object' ? value : {}),
    } as TPdfjsRuntimeLib[K] & T;
}

export default pdfjsLib;

export const AnnotationLayer = getRuntimeExport('AnnotationLayer');
export const AnnotationEditorLayer = getRuntimeExport('AnnotationEditorLayer');
export const AnnotationEditorParamsType = getMergedRuntimeExport(
    'AnnotationEditorParamsType',
    DEFAULT_ANNOTATION_EDITOR_PARAMS_TYPE,
);
export const AnnotationEditorType = getMergedRuntimeExport(
    'AnnotationEditorType',
    DEFAULT_ANNOTATION_EDITOR_TYPE,
);
export const AnnotationEditorUIManager = getRuntimeExport('AnnotationEditorUIManager');
export const AnnotationMode = getMergedRuntimeExport('AnnotationMode', DEFAULT_ANNOTATION_MODE);
export const DrawLayer = getRuntimeExport('DrawLayer');
export const PDFDateString = getRuntimeExport('PDFDateString');
export const PixelsPerInch = getMergedRuntimeExport('PixelsPerInch', DEFAULT_PIXELS_PER_INCH);
export const TextLayer = getRuntimeExport('TextLayer');
