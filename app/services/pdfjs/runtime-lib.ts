import { ensurePdfjsSsrGlobals } from '@app/services/pdfjs/ssr-polyfills';

ensurePdfjsSsrGlobals();

const pdfjsLib = await import('pdfjs-dist');
const pdfjsLibRecord = pdfjsLib as Record<string, unknown>;

function getOptionalExport<T>(name: string) {
    if (!(name in pdfjsLibRecord)) {
        return undefined as T;
    }
    return pdfjsLibRecord[name] as T;
}

export default pdfjsLib;

export const AnnotationLayer = getOptionalExport<typeof pdfjsLib.AnnotationLayer>('AnnotationLayer');
export const AnnotationEditorLayer = getOptionalExport<typeof pdfjsLib.AnnotationEditorLayer>('AnnotationEditorLayer');
export const AnnotationEditorParamsType = getOptionalExport<typeof pdfjsLib.AnnotationEditorParamsType>('AnnotationEditorParamsType');
export const AnnotationEditorType = getOptionalExport<typeof pdfjsLib.AnnotationEditorType>('AnnotationEditorType');
export const AnnotationEditorUIManager = getOptionalExport<typeof pdfjsLib.AnnotationEditorUIManager>('AnnotationEditorUIManager');
export const DrawLayer = getOptionalExport<typeof pdfjsLib.DrawLayer>('DrawLayer');
export const PDFDateString = getOptionalExport<typeof pdfjsLib.PDFDateString>('PDFDateString');
export const PixelsPerInch = getOptionalExport<typeof pdfjsLib.PixelsPerInch>('PixelsPerInch');
export const TextLayer = getOptionalExport<typeof pdfjsLib.TextLayer>('TextLayer');
