

type TTextMarkupColorResolutionSource =
    | 'canvas'
    | 'fallback:none'
    | 'not-text-markup'
    | 'point:element'
    | 'point:nearby-element'
    | 'point:nearby-visual-node'
    | 'point:visual-node'
    | 'summary:element'
    | 'summary:visual-node'
    | 'visual:element'
    | 'visual:visual-node';

export interface ITextMarkupColorResolutionDiagnostics {
    annotationId: string | null;
    color: string | null;
    element: string | null;
    fallbackSource?: TTextMarkupColorResolutionSource | null;
    pageNumber: number | null;
    pointElementCount?: number;
    source: TTextMarkupColorResolutionSource;
    subtype: string | null;
}
