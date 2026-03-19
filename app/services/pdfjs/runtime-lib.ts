import { ensurePdfjsSsrGlobals } from '@app/services/pdfjs/ssr-polyfills';

ensurePdfjsSsrGlobals();

const pdfjsLib = await import('pdfjs-dist');

export default pdfjsLib;

export const {
    AnnotationLayer,
    AnnotationEditorLayer,
    AnnotationEditorParamsType,
    AnnotationEditorType,
    AnnotationEditorUIManager,
    DrawLayer,
    PDFDateString,
    PixelsPerInch,
    TextLayer,
} = pdfjsLib;
