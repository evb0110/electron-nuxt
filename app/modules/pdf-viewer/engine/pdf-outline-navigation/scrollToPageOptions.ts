import type { IAnnotationMarkerRect } from '@app/types/annotations';

export interface IScrollToPageOptions {
    navigationSource?: 'bookmark' | undefined;
    preferExactDom?: boolean;
    /**
     * Align a normalized page y coordinate to the top of the viewport. This is
     * used for PDF outline destinations such as /XYZ and /FitH, where the
     * destination describes a page coordinate rather than an annotation box.
     */
    pageYRatio?: number | null | undefined;
    /**
     * Snap to an already mounted page without queueing another paged render.
     *
     * Fit-height current-page rerenders already start a force render before
     * snapping back to the same page. Queueing the usual post-snap render there
     * can cancel the in-flight canvas render repeatedly on large PDFs, leaving
     * the page skeleton visible. Normal navigation leaves this unset.
     */
    suppressRenderAfterSnap?: boolean;
    markerRect?: IAnnotationMarkerRect | null | undefined;
}
