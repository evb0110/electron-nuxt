import type {
    IPdfConformanceProfile,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/viewers/workspaceDocumentDriver';
import { BrowserLogger } from '@app/utils/browserLogger';
import { readPdfConformanceProfile } from '@app/services/pdf-file/readPdfConformanceProfile';
import { shouldForcePdfSaveAs } from '@app/services/pdf-file/shouldForcePdfSaveAs';

interface IConformanceProfileRequest {
    path: TDocumentRef;
    promise: Promise<IPdfConformanceProfile | null>;
    requestId: number;
}

interface IPendingConformanceProfileRequest {
    fileSize: number | null;
    path: TDocumentRef;
    requestId: number;
}

export interface IPdfConformanceIdleScheduler {
    cancel: (handle: number) => void;
    schedule: (callback: () => void) => number;
}

export interface IPdfConformanceDeferralOptions { fileSize?: number | null }

const MAX_EAGER_PDF_CONFORMANCE_BYTES = 64 * 1024 * 1024;

function createDefaultIdleScheduler(): IPdfConformanceIdleScheduler {
    if (
        typeof window !== 'undefined'
        && typeof window.requestIdleCallback === 'function'
        && typeof window.cancelIdleCallback === 'function'
    ) {
        return {
            cancel: handle => window.cancelIdleCallback(handle),
            schedule: callback => window.requestIdleCallback(callback, {timeout: 2_000}),
        };
    }
    return {
        cancel: handle => window.clearTimeout(handle),
        schedule: callback => window.setTimeout(callback, 0),
    };
}

export function createDocumentConformance(
    state: IDocumentSessionState,
    idleScheduler: IPdfConformanceIdleScheduler = createDefaultIdleScheduler(),
) {
    let conformanceProfileRequestId = 0;
    let conformanceProfileInFlight: IConformanceProfileRequest | null = null;
    let pendingConformanceProfile: IPendingConformanceProfileRequest | null = null;
    let scheduledConformanceHandle: number | null = null;

    function cancelScheduledConformanceAnalysis() {
        if (scheduledConformanceHandle !== null) {
            idleScheduler.cancel(scheduledConformanceHandle);
            scheduledConformanceHandle = null;
        }
    }

    function clearPdfConformanceProfile() {
        conformanceProfileRequestId += 1;
        cancelScheduledConformanceAnalysis();
        conformanceProfileInFlight = null;
        pendingConformanceProfile = null;
        state.pdfConformanceAnalysisState.value = 'none';
        state.pdfConformanceProfile.value = null;
    }

    function applyPdfConformanceProfile(
        path: TDocumentRef,
        requestId: number,
        profile: IPdfConformanceProfile | null,
    ) {
        if (
            conformanceProfileRequestId === requestId
            && state.workingCopyPath.value === path
        ) {
            state.pdfConformanceProfile.value = profile;
            state.pdfConformanceAnalysisState.value = 'ready';
            pendingConformanceProfile = null;
            return true;
        }
        return false;
    }

    function startPdfConformanceAnalysis(request: IPendingConformanceProfileRequest) {
        const inFlight = conformanceProfileInFlight;
        if (inFlight?.path === request.path && inFlight.requestId === request.requestId) {
            return inFlight.promise;
        }

        cancelScheduledConformanceAnalysis();
        state.pdfConformanceAnalysisState.value = 'analyzing';
        const promise = readPdfConformanceProfile(request.path);
        conformanceProfileInFlight = {
            path: request.path,
            promise,
            requestId: request.requestId,
        };
        promise.then((profile) => {
            applyPdfConformanceProfile(request.path, request.requestId, profile);
        }).catch((conformanceError: unknown) => {
            if (
                conformanceProfileRequestId === request.requestId
                && state.workingCopyPath.value === request.path
            ) {
                state.pdfConformanceAnalysisState.value = 'failed';
            }
            BrowserLogger.warn('pdf-file', 'Deferred conformance analysis failed', {
                path: request.path,
                error: conformanceError,
            });
        }).finally(() => {
            if (conformanceProfileInFlight?.requestId === request.requestId) {
                conformanceProfileInFlight = null;
            }
        });
        return promise;
    }

    function deferPdfConformanceProfile(
        path: TDocumentRef,
        options?: IPdfConformanceDeferralOptions,
    ) {
        const requestId = ++conformanceProfileRequestId;
        cancelScheduledConformanceAnalysis();
        conformanceProfileInFlight = null;
        state.pdfConformanceProfile.value = null;
        pendingConformanceProfile = {
            fileSize: options?.fileSize ?? null,
            path,
            requestId,
        };
        if (
            typeof options?.fileSize === 'number'
            && options.fileSize > MAX_EAGER_PDF_CONFORMANCE_BYTES
        ) {
            state.pdfConformanceAnalysisState.value = 'on-demand-only';
            BrowserLogger.debug('pdf-file', 'Skipped eager conformance analysis for large PDF', {
                path,
                size: options.fileSize,
                maxEagerBytes: MAX_EAGER_PDF_CONFORMANCE_BYTES,
            });
            return;
        }
        state.pdfConformanceAnalysisState.value = 'waiting-initial-visual';
    }

    function notifyPdfInitialVisualReady(path: TDocumentRef | null = state.workingCopyPath.value) {
        const pending = pendingConformanceProfile;
        if (
            !path
            || !pending
            || pending.path !== path
            || pending.requestId !== conformanceProfileRequestId
            || state.workingCopyPath.value !== path
            || state.pdfConformanceAnalysisState.value !== 'waiting-initial-visual'
        ) {
            return false;
        }

        state.pdfConformanceAnalysisState.value = 'waiting-idle';
        scheduledConformanceHandle = idleScheduler.schedule(() => {
            scheduledConformanceHandle = null;
            if (
                pendingConformanceProfile !== pending
                || pending.requestId !== conformanceProfileRequestId
                || state.workingCopyPath.value !== pending.path
                || state.pdfConformanceAnalysisState.value !== 'waiting-idle'
            ) {
                return;
            }
            void startPdfConformanceAnalysis(pending).catch(() => {});
        });
        return true;
    }

    async function refreshPdfConformanceProfile(path: TDocumentRef | null) {
        if (!path) {
            clearPdfConformanceProfile();
            return null;
        }

        const inFlight = conformanceProfileInFlight;
        if (inFlight?.path === path) {
            const profile = await inFlight.promise;
            applyPdfConformanceProfile(path, inFlight.requestId, profile);
            return profile;
        }

        const pending = pendingConformanceProfile;
        const request = pending?.path === path
            && pending.requestId === conformanceProfileRequestId
            ? pending
            : {
                fileSize: null,
                path,
                requestId: ++conformanceProfileRequestId,
            };
        pendingConformanceProfile = request;
        const promise = startPdfConformanceAnalysis(request);
        try {
            const profile = await promise;
            applyPdfConformanceProfile(path, request.requestId, profile);
            return profile;
        } finally {
            if (conformanceProfileInFlight?.requestId === request.requestId) {
                conformanceProfileInFlight = null;
            }
        }
    }

    function shouldForceSaveAs(mode: TPdfSaveMode) {
        return shouldForcePdfSaveAs(
            mode,
            state.pdfConformanceProfile.value,
            state.requiresSaveAsOnFirstSave.value,
        );
    }

    async function shouldForceSaveAsForWorkingCopy(
        mode: TPdfSaveMode,
        workingPath: TDocumentRef,
    ) {
        if (state.requiresSaveAsOnFirstSave.value) {
            return true;
        }
        if (!state.pdfConformanceProfile.value) {
            await refreshPdfConformanceProfile(workingPath);
        }
        return shouldForceSaveAs(mode);
    }

    return {
        clearPdfConformanceProfile,
        deferPdfConformanceProfile,
        notifyPdfInitialVisualReady,
        refreshPdfConformanceProfile,
        shouldForceSaveAs,
        shouldForceSaveAsForWorkingCopy,
    };
}
