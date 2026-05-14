import { ensurePdfjsSsrGlobals } from '@app/services/pdfjs/ssrPolyfills';

ensurePdfjsSsrGlobals();

const pdfjsLib = await import('pdfjs-dist');

function getOptionalExport<K extends keyof typeof pdfjsLib>(name: K) {
    if (!(name in pdfjsLib)) {
        throw new Error(`Missing pdfjs-dist export: ${String(name)}`);
    }
    return pdfjsLib[name];
}

export default pdfjsLib;

export const AnnotationLayer = getOptionalExport('AnnotationLayer');
export const AnnotationEditorLayer = getOptionalExport('AnnotationEditorLayer');
export const AnnotationEditorParamsType = getOptionalExport('AnnotationEditorParamsType');
export const AnnotationEditorType = getOptionalExport('AnnotationEditorType');
export const AnnotationEditorUIManager = getOptionalExport('AnnotationEditorUIManager');
export const AnnotationMode = getOptionalExport('AnnotationMode');
export const DrawLayer = getOptionalExport('DrawLayer');
export const PDFDateString = getOptionalExport('PDFDateString');
export const PixelsPerInch = getOptionalExport('PixelsPerInch');
export const TextLayer = getOptionalExport('TextLayer');
