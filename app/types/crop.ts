import type { ILocalRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';
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
