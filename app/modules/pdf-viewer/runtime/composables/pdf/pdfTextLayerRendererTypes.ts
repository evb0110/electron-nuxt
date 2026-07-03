import type {
    IPdfPageMatches,
    IPdfSearchMatch,
} from '@app/types/pdfUi';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';

export interface IHighlightDebugInfo {
    userUnit: number;
    totalScaleFactor: number;
    viewportWidth: number;
    viewportHeight: number;
    rawPageWidth: number;
    rawPageHeight: number;
    canvasPixelWidth: number;
    canvasPixelHeight: number;
    renderScaleX: number;
    renderScaleY: number;
}

export interface IPageHighlightSignatureState {
    signatureByPage: Map<number, string>;
    pendingRoot: HTMLElement | null;
    rafId: number;
    continuationRafId: number;
    refreshVersion: number;
}

export interface IHighlightDebugGuard {
    current: IPdfSearchMatch;
    query: string;
    scale: number;
}

export type TTextLayerTextContentSource = TextContent | ReadableStream;
export type TPageMatchEntry = IPdfPageMatches['matches'][number];

export interface IHighlightDebugRects {
    canvasRect: DOMRect;
    textRect: DOMRect;
    containerRect: DOMRect | null;
    canvasHostRect: DOMRect | null;
    highlightRect: DOMRect | null;
    computedTotalScaleFactor: string;
    currentSpanInfo: string;
}
