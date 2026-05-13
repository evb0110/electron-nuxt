import { ensurePdfjsSsrGlobals } from '@app/services/pdfjs/ssrPolyfills';
import pdfjsLib from '@app/services/pdfjs/runtimeLib';

ensurePdfjsSsrGlobals();

(globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjsLib }).pdfjsLib = pdfjsLib;

const pdfjsViewerLib = await import('pdfjs-dist/web/pdf_viewer.mjs');

export const {
    EventBus,
    GenericL10n,
} = pdfjsViewerLib;
