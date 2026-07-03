import type {
    IPdfConformanceProfile,
    TPdfSaveMode,
} from '@app/types/pdfContracts';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IDocumentSessionState } from '@app/modules/workspace-shell/composables/document-session/createDocumentSessionState';
import { BrowserLogger } from '@app/utils/browserLogger';
import { readPdfConformanceProfile } from '@app/services/pdf-file/readPdfConformanceProfile';
import { shouldForcePdfSaveAs } from '@app/services/pdf-file/shouldForcePdfSaveAs';

interface IConformanceProfileRequest {
    path: TDocumentRef;
    promise: Promise<IPdfConformanceProfile | null>;
    requestId: number;
}

export interface IPdfConformanceDeferralOptions { fileSize?: number | null }

const MAX_EAGER_PDF_CONFORMANCE_BYTES = 64 * 1024 * 1024;

export function createDocumentConformance(state: IDocumentSessionState) {
    let conformanceProfileRequestId = 0;
    let conformanceProfileInFlight: IConformanceProfileRequest | null = null;

    function clearPdfConformanceProfile() {
        conformanceProfileRequestId += 1;
        conformanceProfileInFlight = null;
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
            return true;
        }
        return false;
    }

    function deferPdfConformanceProfile(
        path: TDocumentRef,
        options?: IPdfConformanceDeferralOptions,
    ) {
        const requestId = ++conformanceProfileRequestId;
        state.pdfConformanceProfile.value = null;
        if (
            typeof options?.fileSize === 'number'
            && options.fileSize > MAX_EAGER_PDF_CONFORMANCE_BYTES
        ) {
            conformanceProfileInFlight = null;
            BrowserLogger.debug('pdf-file', 'Skipped eager conformance analysis for large PDF', {
                path,
                size: options.fileSize,
                maxEagerBytes: MAX_EAGER_PDF_CONFORMANCE_BYTES,
            });
            return;
        }

        const promise = readPdfConformanceProfile(path);
        conformanceProfileInFlight = {
            path,
            promise,
            requestId,
        };
        promise.then((profile) => {
            applyPdfConformanceProfile(path, requestId, profile);
        }).catch((conformanceError: unknown) => {
            BrowserLogger.warn('pdf-file', 'Deferred conformance analysis failed', {
                path,
                error: conformanceError,
            });
        }).finally(() => {
            if (conformanceProfileInFlight?.requestId === requestId) {
                conformanceProfileInFlight = null;
            }
        });
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

        const requestId = ++conformanceProfileRequestId;
        const promise = readPdfConformanceProfile(path);
        conformanceProfileInFlight = {
            path,
            promise,
            requestId,
        };
        const profile = await promise;
        applyPdfConformanceProfile(path, requestId, profile);
        if (conformanceProfileInFlight?.requestId === requestId) {
            conformanceProfileInFlight = null;
        }
        return profile;
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
        refreshPdfConformanceProfile,
        shouldForceSaveAs,
        shouldForceSaveAsForWorkingCopy,
    };
}
