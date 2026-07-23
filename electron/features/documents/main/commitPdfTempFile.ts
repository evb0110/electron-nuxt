import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { markActiveWorkingCopyMutationCommitStarted } from '@electron/file-access/workingCopyMutationCommitSignal';
import { mainJobBroker } from '@electron/resources/jobBroker';
import type { IJobBrokerLease } from '@electron/resources/jobBroker';
import { documentOutputService } from '@electron/output/documentOutputService';
import { getPdfNativeToolPaths } from '@electron/pdf/nativeToolPaths';
import type {ITypedStagedArtifact} from '@contracts/stagedArtifacts';
import type {IDocumentsSenderIdContext} from '@electron/features/documents/documentsService';
import {resolveTypedStagedArtifact} from '@electron/features/documents/main/managedTempFileHandles';
import {runDocumentSaveUtilityProcess} from '@electron/features/documents/main/fingerprintFileWithUtilityProcess';

const DEFAULT_THRESHOLD = 64 * 1024 * 1024;
const SAVE_UTILITY_THRESHOLD = (() => {
    const value = Number.parseInt(process.env.EVB_DOCUMENT_SAVE_UTILITY_THRESHOLD_BYTES ?? `${DEFAULT_THRESHOLD}`, 10);
    return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_THRESHOLD;
})();

function shouldUseDocumentSaveUtility(bytes: number) {
    return bytes >= SAVE_UTILITY_THRESHOLD;
}

export async function commitPdfTempFile(sourcePath: string, targetPath: string, options: {
    expectedBytes?: number;
    signal?: AbortSignal;
    ownerId?: string;
    changedObjectRefs?: string[];
    receipt?: {
        artifact: ITypedStagedArtifact;
        context: IDocumentsSenderIdContext;
    };
} = {}) {
    const outputJob = documentOutputService.start({
        operation: 'save-as-pdf',
        sourceKind: 'pdf',
        initialPhase: 'validating',
    });
    const signal = options.signal
        ? AbortSignal.any([
            options.signal,
            outputJob.signal,
        ])
        : outputJob.signal;
    let lease: IJobBrokerLease | undefined;
    try {
        const stagedArtifact = options.receipt === undefined
            ? undefined
            : await resolveTypedStagedArtifact(
                options.receipt.context,
                options.receipt.artifact,
            );
        if (stagedArtifact !== undefined && stagedArtifact.path !== sourcePath) {
            throw new Error('Staged artifact receipt does not identify the PDF commit source');
        }
        if (
            stagedArtifact !== undefined
            && options.expectedBytes !== undefined
            && options.expectedBytes !== stagedArtifact.size
        ) {
            throw new Error('Staged artifact receipt size does not match the PDF commit request');
        }
        const expectedBytes = options.expectedBytes
            ?? stagedArtifact?.size
            ?? (await stat(sourcePath)).size;
        if (!shouldUseDocumentSaveUtility(expectedBytes) && !options.changedObjectRefs?.length) {
            const {atomicReplace} = await import('@electron/utils/atomicReplace');
            await atomicReplace(sourcePath, targetPath);
            documentOutputService.handoff(outputJob.jobId, targetPath, {
                phase: 'publishing',
                percent: 100,
            });
            documentOutputService.finish(outputJob.jobId, 'completed');
            return null;
        }
        lease = await mainJobBroker.acquire({
            ownerId: options.ownerId ?? `document-save:${targetPath}`,
            kind: 'document-save-utility',
            priority: 'user',
            resources: {
                cpuTokens: 1,
                estimatedResidentBytes: 256 * 1024 * 1024,
                nativeProcesses: 1,
                ioWeight: 4,
            },
            signal,
        });
        markActiveWorkingCopyMutationCommitStarted();
        const result = await runDocumentSaveUtilityProcess({
            cwd: dirname(sourcePath),
            serviceName: 'EVB document save',
            utilityName: 'Document save utility',
            timeoutMs: 10 * 60_000,
            signal,
            request: {
                type: 'commit',
                sourcePath,
                targetPath,
                expectedBytes,
                validationBinary: getPdfNativeToolPaths().qpdf,
                ...(options.changedObjectRefs?.length ? {changedObjectRefs: options.changedObjectRefs} : {}),
                ...(stagedArtifact === undefined ? {} : {stagedArtifact}),
            },
        });
        documentOutputService.handoff(outputJob.jobId, targetPath, {
            phase: 'publishing',
            percent: 100,
        });
        documentOutputService.finish(outputJob.jobId, 'completed');
        return result;
    } catch (error) {
        documentOutputService.finish(
            outputJob.jobId,
            signal.aborted ? 'canceled' : 'failed',
            error instanceof Error ? error.message : String(error),
        );
        throw error;
    } finally {
        lease?.release();
    }
}
