import type { TOpenFileResult } from '@contracts/platformApi';
import { browserDocumentStore } from '@app/platform/browserDocumentStore';
import { createCombinedPdfFromPaths } from '@app/platform/browser-api/browserCombineService';
import { hasElectronAPI } from '@app/utils/platform';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

export interface ICombinePdfInputFile {file: File;}

export interface ICombinePdfProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

export interface ICombinePdfFilesOptions {
    files: readonly ICombinePdfInputFile[];
    outputName: string;
    openErrorMessage: string;
    onProgress?: (progress: ICombinePdfProgress) => void;
}

async function registerBrowserInputFiles(files: readonly ICombinePdfInputFile[]) {
    const refs: string[] = [];
    for (const entry of files) {
        const ref = await browserDocumentStore.registerFile(entry.file, {
            kind: 'source',
            retention: 'transient',
            saveKind: 'generic',
            saveHandle: null,
        });
        refs.push(ref);
    }
    return refs;
}

async function cleanupRegisteredRefs(refs: string[]) {
    await Promise.allSettled(refs.map(ref => browserDocumentStore.remove(ref)));
}

function emitCompleteProgress(
    options: ICombinePdfFilesOptions,
    previousProgress?: ICombinePdfProgress | null,
) {
    options.onProgress?.({
        processed: options.files.length,
        total: options.files.length,
        percent: 100,
        elapsedMs: previousProgress?.elapsedMs ?? 0,
        estimatedRemainingMs: null,
    });
}

async function combineElectronFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    const documents = getDocumentsCapability();
    const inputPaths = options.files
        .map(entry => documents.getPathForFile(entry.file).trim())
        .filter(path => path.length > 0);

    if (inputPaths.length !== options.files.length) {
        throw new Error(options.openErrorMessage);
    }

    const requestId = crypto.randomUUID();
    let latestProgress: ICombinePdfProgress | null = null;
    const stopProgress = documents.onOpenDocumentDirectBatchProgress((nextProgress) => {
        if (nextProgress.requestId !== requestId) {
            return;
        }

        latestProgress = {
            processed: nextProgress.processed,
            total: nextProgress.total,
            percent: nextProgress.percent,
            elapsedMs: nextProgress.elapsedMs,
            estimatedRemainingMs: nextProgress.estimatedRemainingMs,
        };
        options.onProgress?.(latestProgress);
    });

    try {
        const result = await documents.openDocumentDirectBatch(inputPaths, requestId);
        if (!result) {
            throw new Error(options.openErrorMessage);
        }

        emitCompleteProgress(options, latestProgress);
        return result;
    } finally {
        stopProgress();
    }
}

async function combineBrowserFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    let refs: string[] = [];
    let latestProgress: ICombinePdfProgress | null = null;
    try {
        refs = await registerBrowserInputFiles(options.files);
        const combinedPdf = await createCombinedPdfFromPaths(refs, {onProgress: (nextProgress) => {
            latestProgress = nextProgress;
            options.onProgress?.(nextProgress);
        }});
        const workingPath = await getDocumentsCapability().createWorkingCopyFromData(
            options.outputName,
            combinedPdf,
        );
        emitCompleteProgress(options, latestProgress);
        return {
            kind: 'pdf',
            workingPath,
            originalPath: workingPath,
            isGenerated: true,
        };
    } finally {
        if (refs.length > 0) {
            await cleanupRegisteredRefs(refs);
        }
    }
}

export function combinePdfFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    return hasElectronAPI()
        ? combineElectronFiles(options)
        : combineBrowserFiles(options);
}
