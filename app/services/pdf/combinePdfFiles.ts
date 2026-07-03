import type { TOpenFileResult } from '@contracts/electronApiDocuments';
import { hasElectronAPI } from '@app/utils/platform';
import {
    getDocumentMenuCapability,
    getDocumentOpenCapability,
    getDocumentPickerCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';

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
    const documentPicker = getDocumentPickerCapability();
    const documentOpen = getDocumentOpenCapability();
    const documentMenu = getDocumentMenuCapability();
    const inputPaths = documentPicker.getPathsForFiles(options.files.map(entry => entry.file))
        .map(path => path.trim())
        .filter(path => path.length > 0);

    if (inputPaths.length !== options.files.length) {
        throw new Error(options.openErrorMessage);
    }

    const requestId = crypto.randomUUID();
    let latestProgress: ICombinePdfProgress | null = null;
    const stopProgress = documentMenu.onOpenDocumentDirectBatchProgress((nextProgress) => {
        if (
            nextProgress.operation !== 'document-open'
            || nextProgress.requestId !== requestId
        ) {
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
        const result = await documentOpen.openDocumentDirectBatch(inputPaths, requestId);
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
    let latestProgress: ICombinePdfProgress | null = null;
    const documentPicker = getDocumentPickerCapability();
    if (!documentPicker.createCombinedPdfFromFiles) {
        throw new Error(options.openErrorMessage);
    }

    const combinedPdf = await documentPicker.createCombinedPdfFromFiles(
        options.files.map(entry => entry.file),
        {onProgress: (nextProgress) => {
            latestProgress = nextProgress;
            options.onProgress?.(nextProgress);
        }},
    );
    const workingPath = await getDocumentWorkingCopyCapability().createWorkingCopyFromData(
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
}

export function combinePdfFiles(options: ICombinePdfFilesOptions): Promise<TOpenFileResult> {
    return hasElectronAPI()
        ? combineElectronFiles(options)
        : combineBrowserFiles(options);
}
