import type { ILocalRect } from '@app/utils/document-viewer/region-geometry/regionGeometryTypes';
import type { ICropMargins } from '@contracts/shared';
import type { TPageSelection } from '@contracts/pageNumbers';

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
    pageSelection?: TPageSelection;
}

export interface ICropRemovePayload {
    pages: number[];
    pageSelection?: TPageSelection;
}

export type TCropUnit = 'pt' | 'mm' | 'in';
