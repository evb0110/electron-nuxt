import type { Component } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import type { IWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';

export type TWorkspaceViewerAdapterId = 'pdf' | 'native-pdf' | 'djvu';
export type TWorkspaceViewerDocumentType = 'pdf' | 'image' | 'djvu';

export interface IWorkspaceViewerOpenLifecycleState { previousWorkingCopyPath: TDocumentRef | null; }

export interface IWorkspaceViewerLifecycleContext {
    cleanupDjvuTemp: () => Promise<void>;
    exitDjvuMode: () => void;
    invalidatePendingDjvuOpen: () => void;
    isDjvuMode: { value: boolean };
    workingCopyPath: { value: TDocumentRef | null };
}

export interface IWorkspaceViewerLifecycleHooks {
    beforeOpen?: () => Promise<void> | void;
    afterOpen?: (
        outcome: TDocumentOpenOutcome,
        state: IWorkspaceViewerOpenLifecycleState,
    ) => Promise<void> | void;
    beforeClose?: () => Promise<void> | void;
}

export interface IWorkspaceViewerAdapter {
    id: TWorkspaceViewerAdapterId;
    component: Component;
    documentTypes: readonly TWorkspaceViewerDocumentType[];
    capabilities: IWorkspaceViewerCapabilities;
    createLifecycleHooks?: (context: IWorkspaceViewerLifecycleContext) => IWorkspaceViewerLifecycleHooks;
}

export interface IWorkspaceViewerResolveContext {
    djvuSourcePath: TDocumentRef | null;
    isDjvuMode: boolean;
    pdfSourcePath: TDocumentRef | null;
    shouldUseNativePdf: boolean;
}
