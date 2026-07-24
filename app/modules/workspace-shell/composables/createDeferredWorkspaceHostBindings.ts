import type {
    ComputedRef,
    EmitFn,
    ShallowRef,
} from 'vue';
import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import type { TStartSection } from '@app/types/startSection';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import type { IWorkspaceDocumentRecord } from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import type { IWorkspaceDocumentController } from '@app/modules/workspace-shell/document-sessions/workspaceDocumentController';
import type { ITabViewSessionState } from '@app/modules/workspace-shell/tabs/tabSessionStoreTypes';

export interface IDeferredWorkspaceHostEmits {
    'update-document-record': [record: IWorkspaceDocumentRecord];
    'update-session-state': [state: ITabViewSessionState];
    'update:start-section': [section: TStartSection];
    'open-in-new-tab': [result: string | TOpenFileResult];
    'request-close-tab': [];
    'open-settings': [];
    'open-combine': [];
    'toggle-fullscreen': [];
    'expose-ready': [expose: IWorkspaceExpose];
    'expose-released': [];
}

export function createDeferredWorkspaceHostBindings(options: {
    emit: EmitFn<IDeferredWorkspaceHostEmits>;
    activeDocumentSession: ComputedRef<IWorkspaceDocumentController>;
    mountedWorkspace: ShallowRef<IWorkspaceExpose | null>;
}) {
    return {
        handleDocumentRecordUpdate(record: IWorkspaceDocumentRecord) {
            options.emit('update-document-record', record);
        },
        handleStartSectionUpdate: (section: TStartSection) => options.emit('update:start-section', section),
        handleOpenInNewTab: (result: string | TOpenFileResult) => options.emit('open-in-new-tab', result),
        handleRequestCloseTab: () => options.emit('request-close-tab'),
        handleOpenSettings: () => options.emit('open-settings'),
        handleOpenCombine: () => options.emit('open-combine'),
        handleToggleFullscreen: () => options.emit('toggle-fullscreen'),
        handleWorkspaceExposeReady(expose: IWorkspaceExpose) {
            options.mountedWorkspace.value = expose;
            options.activeDocumentSession.value.attachWorkspace(expose);
        },
        handleWorkspaceExposeReleased(expose: IWorkspaceExpose) {
            if (options.mountedWorkspace.value !== expose) {
                return;
            }
            options.mountedWorkspace.value = null;
            options.activeDocumentSession.value.detachWorkspace(expose);
        },
    };
}
