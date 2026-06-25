import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { TViewerResidencyState } from '@app/utils/document-viewer/memory/viewerResidencyPolicy';

export type TTabTemperature = 'hot' | 'warm' | 'cold';

export interface ITabViewSessionState {
    zoom: number;
    effectiveZoom: number;
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    showSidebar: boolean;
    continuousScroll: boolean;
}

export interface ITabLifecycleState {
    tabId: string;
    temperature: TTabTemperature;
    viewerResidency: TViewerResidencyState;
    isReclaimCandidate: boolean;
    shouldMountHost: boolean;
}
