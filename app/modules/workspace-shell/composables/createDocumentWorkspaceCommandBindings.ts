import type { TDocumentRef } from '@contracts/documentRef';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TStartSection } from '@app/types/startSection';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IDocumentOpeningPageFrameAuthority } from '@app/utils/document-viewer/chassis/documentOpeningPageFrameAuthority';
import type { IWorkspaceSplitCacheSessionState } from '@app/modules/workspace-shell/composables/workspaceSplitTypes';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentSessionController } from '@app/modules/workspace-shell/document-sessions/documentSessionTypes';

export interface IDocumentWorkspaceProps {
    tabId: string;
    isActive: boolean;
    isRenderActive?: boolean | undefined;
    isTabTransitionBusy: boolean;
    isFullscreen: boolean;
    fullscreenSupported: boolean;
    isWorkspaceLayoutResizing?: boolean | undefined;
    documentSession?: IWorkspaceDocumentSessionController | null | undefined;
    initialViewState?: ITabViewSessionState | null | undefined;
    pendingDocumentOpen?: boolean | undefined;
    pendingDocumentPath?: TDocumentRef | null | undefined;
    suppressEmptyState?: boolean | undefined;
    splitCacheSession?: IWorkspaceSplitCacheSessionState | null | undefined;
    startSection?: TStartSection | undefined;
}

export interface IDocumentWorkspaceEmits {
    'update-document-record': [record: IWorkspaceDocumentRecord];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: TDocumentRef | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'viewer-owner-ready': [authority: IDocumentOpeningPageFrameAuthority];
    'expose-ready': [expose: IWorkspaceExpose];
    'expose-released': [];
}

interface IDocumentWorkspaceCommandEmitter {
    (event: 'update:start-section', section: TStartSection): void;
    (event: 'open-settings'): void;
    (event: 'open-combine'): void;
    (event: 'toggle-fullscreen'): void;
}

export function createDocumentWorkspaceCommandBindings(emit: IDocumentWorkspaceCommandEmitter) {
    return {
        handleStartSectionUpdate: (section: TStartSection) => emit('update:start-section', section),
        handleOpenSettings: () => emit('open-settings'),
        handleOpenCombine: () => emit('open-combine'),
        handleToggleFullscreen: () => emit('toggle-fullscreen'),
    };
}
