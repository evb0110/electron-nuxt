import type { TZoomMode } from '@contracts/shared';

export interface IPdfOpeningPageFrameRecord {
    readonly generation: number;
    readonly pageNumber: number;
    readonly zoom: number;
    readonly zoomMode: TZoomMode;
    readonly style: Readonly<Record<string, string>>;
}

export function createPdfOpeningPageFrameRecord(
    input: Omit<IPdfOpeningPageFrameRecord, 'style'> & {style: Record<string, string>},
): IPdfOpeningPageFrameRecord {
    return Object.freeze({
        ...input,
        style: Object.freeze({...input.style}),
    });
}
