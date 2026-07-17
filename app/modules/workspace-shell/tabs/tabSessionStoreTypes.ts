import type {
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@contracts/shared';
import type { TViewerResidencyState } from '@app/utils/document-viewer/memory/viewerResidencyPolicy';
import type { TDocumentSidebarTab } from '@app/utils/document-viewer/sidebar/documentSidebarTabs';

export type TTabTemperature = 'hot' | 'warm' | 'cold';

export interface ITabViewSessionState {
    /** Optional for checkpoints written before page continuity was persisted. */
    currentPage?: number;
    zoom: number;
    effectiveZoom: number;
    zoomMode: TZoomMode;
    fitMode: TFitMode;
    viewMode: TPdfViewMode;
    showSidebar: boolean;
    /** Optional for checkpoints written before the shared sidebar session existed. */
    sidebarTab?: TDocumentSidebarTab;
    /** Optional for backwards-compatible restore of older checkpoints. */
    sidebarWidth?: number;
    continuousScroll: boolean;
}

export interface ITabLifecycleState {
    tabId: string;
    temperature: TTabTemperature;
    viewerResidency: TViewerResidencyState;
    isReclaimCandidate: boolean;
    shouldMountHost: boolean;
}
