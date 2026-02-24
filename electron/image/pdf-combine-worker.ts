import {
    parentPort,
    workerData,
} from 'worker_threads';
import {
    createCombinedPdf as createCombinedPdfShared,
    type ICreateCombinedPdfProgress,
} from '@electron/image/pdf-combine-shared';

interface ICombineWorkerData {inputPaths?: unknown;}
interface ICombineWorkerProgressPayload extends ICreateCombinedPdfProgress {type: 'progress';}

interface ICombineWorkerResultPayload {
    type: 'result';
    ok: boolean;
    error?: string;
    data?: Uint8Array;
}

async function createCombinedPdf(
    inputPaths: string[],
    onProgress?: (progress: ICreateCombinedPdfProgress) => void,
): Promise<Uint8Array> {
    return createCombinedPdfShared(inputPaths, {
        onProgress,
        unsupportedFileError: (sourcePath) => `Unsupported file type for worker combine: ${sourcePath}`,
    });
}

function resolveWorkerInputPaths(): string[] {
    const currentWorkerData = workerData as ICombineWorkerData | undefined;
    if (!Array.isArray(currentWorkerData?.inputPaths)) {
        return [];
    }
    return currentWorkerData.inputPaths
        .filter((path): path is string => typeof path === 'string');
}

async function runCombineWorker() {
    if (!parentPort) {
        throw new Error('Image combine worker started without a parentPort');
    }
    const port = parentPort;

    try {
        const inputPaths = resolveWorkerInputPaths();
        const output = await createCombinedPdf(inputPaths, (progress) => {
            const progressPayload: ICombineWorkerProgressPayload = {
                type: 'progress',
                ...progress,
            };
            port.postMessage(progressPayload);
        });
        const payload: ICombineWorkerResultPayload = {
            type: 'result',
            ok: true,
            data: output,
        };
        port.postMessage(payload);
    } catch (error) {
        const payload: ICombineWorkerResultPayload = {
            type: 'result',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
        port.postMessage(payload);
    }
}

await runCombineWorker();
