import type {TDocumentRef} from '@contracts/documentRef';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerNativeRequiredFailure,
    INativePdfMutationProjection,
} from '@app/modules/pdf-viewer/public';
import {getDocumentFilesCapability} from '@app/utils/platformDocuments';
import {toPdfDateString} from '@app/utils/pdfDate';

export class NativePdfSaveRequiredError extends Error {
    readonly code = 'native-save-required' as const;
    readonly failure: IPdfViewerNativeRequiredFailure;

    constructor(failure: IPdfViewerNativeRequiredFailure) {
        super(failure.detail ?? 'Native PDF persistence is required for this document');
        this.name = 'NativePdfSaveRequiredError';
        this.failure = failure;
    }
}

export interface INativePdfSaveTransactionOptions {
    nativeCapabilities: NonNullable<IPdfViewerSaveTransactionRequest['nativeCapabilities']>;
    dirtyState: NonNullable<IPdfViewerSaveTransactionRequest['dirtyState']>;
    documentStructure: NonNullable<IPdfViewerSaveTransactionRequest['documentStructure']>;
    forcePdfjsMaterialize?: boolean;
    savedPdfjsAnnotationFingerprint?: string | null;
};

function createCapabilityFailure(detail: string): NativePdfSaveRequiredError {
    return new NativePdfSaveRequiredError({
        code: 'native-save-required',
        phase: 'pre-write',
        reason: 'missing-native-capability',
        detail,
    });
}

export interface IConsumeNativePdfMutationProjectionOptions {
    workingPath: TDocumentRef;
    expectedDocumentRevisionToken: TDocumentRevisionToken | null | undefined;
    projection: INativePdfMutationProjection;
    operation: 'clone' | 'replace';
    originalPath?: TDocumentRef | null;
    verifyPathBeforeExpose?: (path: TDocumentRef, knownSize: number) => Promise<void>;
    assertBeforeExpose?: () => Promise<void> | void;
}

/**
 * Stages a native replayable mutation and hands its immutable receipt to the
 * requested path operation. The receipt consumer owns the staged lease after
 * handoff. Every rejected handoff releases the lease here.
 */
export async function consumeNativePdfMutationProjection(
    options: IConsumeNativePdfMutationProjectionOptions,
): Promise<TDocumentRef | null> {
    const files = getDocumentFilesCapability();
    if (
        typeof files.releaseManagedTempFileHandle !== 'function'
        || typeof files.applyPdfNativeMutationsToWorkingCopy !== 'function'
    ) {
        throw createCapabilityFailure('Native PDF mutation staging is unavailable');
    }
    if (options.expectedDocumentRevisionToken === null || options.expectedDocumentRevisionToken === undefined) {
        throw createCapabilityFailure('Native PDF mutation staging requires the document revision');
    }
    let stagedLeaseConsumed = false;
    let stagedOutput: ITypedStagedArtifact | null = null;
    try {
        const applied = await files.applyPdfNativeMutationsToWorkingCopy(
            options.workingPath,
            options.projection.mutations,
            toPdfDateString(),
            {expectedDocumentRevisionToken: options.expectedDocumentRevisionToken},
        );
        if (!applied.applied || !applied.validation?.isValid) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'native-decline',
                detail: applied.error?.message ?? 'Native PDF mutation was not applied',
            });
        }
        if (!applied.stagedOutput) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'native-error',
                detail: 'Native PDF mutation did not return a staged artifact',
            });
        }
        stagedOutput = applied.stagedOutput;
        await options.verifyPathBeforeExpose?.(stagedOutput.path, stagedOutput.size);
        await options.assertBeforeExpose?.();
        // The receipt consumer validates owner, lease, revision, identity,
        // and stat witness again before it changes any working-copy bytes.
        if (options.operation === 'clone') {
            const cloneConsumer = files.cloneStagedPdfNativeMutationToWorkingCopy;
            if (typeof cloneConsumer !== 'function') {
                throw createCapabilityFailure('Native split snapshot staging is unavailable');
            }
            const clonePath = await cloneConsumer(
                stagedOutput,
                options.originalPath ?? undefined,
            );
            stagedLeaseConsumed = true;
            return clonePath;
        }
        const replaceConsumer = files.replaceWorkingCopyFromStagedPdfNativeMutation;
        if (typeof replaceConsumer !== 'function') {
            throw createCapabilityFailure('Native page-mutation staging is unavailable');
        }
        const replaced = await replaceConsumer(
            options.workingPath,
            stagedOutput,
            {expectedDocumentRevisionToken: options.expectedDocumentRevisionToken},
        );
        stagedLeaseConsumed = true;
        if (!replaced) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'native-error',
                detail: 'Native PDF mutation did not replace the working copy',
            });
        }
        return null;
    } finally {
        // If verification failed before handing the receipt to a consumer,
        // release the staged lease. A successful consumer releases it itself.
        if (!stagedLeaseConsumed && stagedOutput) {
            await files.releaseManagedTempFileHandle(stagedOutput.leaseId);
        }
    }
}
