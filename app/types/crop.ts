import type { ILocalRect } from '@app/composables/pdf/pdfRegionGeometry';
import type { ICropMargins } from '@contracts/shared';

export type {
    ICropMargins,
    IPdfBox,
    IPageGeometry,
} from '@contracts/shared';

export interface ICropSelectionResult {
    pageNumber: number;
    pageRect: {
        width: number;
        height: number;
    };
    pageLocalRect: ILocalRect;
}

export interface ICropApplyPayload {
    margins: ICropMargins;
    pages: number[];
}

export interface ICropRemovePayload { pages: number[]; }

export type TCropUnit = 'pt' | 'mm' | 'in';

export type TCropScope = 'all' | 'current' | 'even' | 'odd' | 'range' | 'selected';
