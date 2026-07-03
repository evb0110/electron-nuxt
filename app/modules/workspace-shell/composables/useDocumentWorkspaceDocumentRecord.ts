import type {
    ComputedRef,
    Ref,
} from 'vue';
import { clamp } from 'es-toolkit/math';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentRevisionInfo } from '@contracts/documentRevision';
import type { IWorkspaceToolbarSnapshot } from '@app/types/workspaceExpose';
import { buildPendingTabDocumentHint } from '@app/modules/workspace-shell/tabs/buildPendingTabDocumentHint';
import { resolveWorkspaceTabUpdate } from '@app/modules/workspace-shell/state/resolveWorkspaceTabUpdate';
import {
    createPendingWorkspaceViewState,
    createWorkspaceDocumentRecord,
    type IWorkspaceDocumentRecord,
} from '@app/modules/workspace-shell/state/workspaceDocumentRecord';
import { getWorkspaceViewerCapabilitiesForDocumentType } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';

interface IOpenBatchProgress {
    processed: number;
    total: number;
}

interface IUseDocumentWorkspaceDocumentRecordOptions {
    pendingDocumentOpen: Ref<boolean>;
    pendingDocumentPath: Ref<TDocumentRef | null | undefined>;
    openBatchProgress: Ref<IOpenBatchProgress | null | undefined>;
    hasPdf: Ref<boolean>;
    isDjvuMode: Ref<boolean>;
    fileName: Ref<string | null>;
    originalPath: Ref<TDocumentRef | null>;
    documentIdentity: Ref<IDocumentRevisionInfo | null>;
    isDirty: Ref<boolean>;
    djvuSourcePath: Ref<TDocumentRef | null>;
    toolbarSnapshot: Ref<IWorkspaceToolbarSnapshot>;
    formatPendingBatchLabel: (values: IOpenBatchProgress) => string;
    publishRecord: (record: IWorkspaceDocumentRecord) => void;
}

interface IUseDocumentWorkspaceDocumentRecordResult { workspaceDocumentRecord: ComputedRef<IWorkspaceDocumentRecord>; }

export const useDocumentWorkspaceDocumentRecord = (
    options: IUseDocumentWorkspaceDocumentRecordOptions,
): IUseDocumentWorkspaceDocumentRecordResult => {
    function resolvePendingOpenDisplayName(): string | null {
        const progress = options.openBatchProgress.value;
        if (!progress || progress.total <= 0) {
            return null;
        }
        return options.formatPendingBatchLabel({
            processed: clamp(progress.processed, 0, progress.total),
            total: progress.total,
        });
    }

    const workspaceDocumentRecord: ComputedRef<IWorkspaceDocumentRecord> = computed(() => {
        const pendingHint = options.pendingDocumentPath.value
            ? buildPendingTabDocumentHint(options.pendingDocumentPath.value)
            : null;
        const isPendingDocumentHint = Boolean(pendingHint && !options.hasPdf.value && !options.isDjvuMode.value);
        const tab = isPendingDocumentHint && pendingHint
            ? {
                fileName: resolvePendingOpenDisplayName() ?? pendingHint.fileName ?? null,
                originalPath: pendingHint.originalPath ?? null,
                isDirty: options.isDirty.value,
                isDjvu: pendingHint.isDjvu ?? false,
            }
            : resolveWorkspaceTabUpdate({
                fileName: options.fileName.value,
                pendingOpenDisplayName: resolvePendingOpenDisplayName(),
                originalPath: options.originalPath.value,
                isDirty: options.isDirty.value,
                isDjvuMode: options.isDjvuMode.value,
                djvuSourcePath: options.djvuSourcePath.value,
            });
        const toolbarSnapshot = isPendingDocumentHint && pendingHint
            ? {
                ...options.toolbarSnapshot.value,
                hasPdf: true,
                isDjvuMode: pendingHint.isDjvu ?? false,
                isOpeningDocument: true,
                viewerCapabilities: getWorkspaceViewerCapabilitiesForDocumentType(pendingHint.isDjvu ? 'djvu' : 'pdf'),
            }
            : options.toolbarSnapshot.value;
        return createWorkspaceDocumentRecord({
            tab,
            documentIdentity: isPendingDocumentHint ? null : options.documentIdentity.value,
            toolbarSnapshot,
            ...(isPendingDocumentHint
                ? { viewState: createPendingWorkspaceViewState(toolbarSnapshot) }
                : {}),
        });
    });

    watch(workspaceDocumentRecord, record => options.publishRecord(record), { immediate: true });

    return { workspaceDocumentRecord };
};
