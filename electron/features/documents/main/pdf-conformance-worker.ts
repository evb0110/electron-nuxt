import {
    parentPort,
    workerData,
} from 'worker_threads';
import { analyzePdfConformanceFileDirect } from '@electron/features/documents/main/pdf-conformance-core';
import { getErrorMessage } from '@electron/utils/error';

interface IPdfConformanceWorkerData { filePath?: unknown; }

type TPdfConformanceWorkerResult =
    | {
        type: 'result';
        ok: true;
        data: unknown;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };

function resolveWorkerFilePath(): string {
    const currentWorkerData = workerData as IPdfConformanceWorkerData | undefined;
    if (typeof currentWorkerData?.filePath !== 'string' || currentWorkerData.filePath.trim().length === 0) {
        throw new Error('Invalid PDF conformance worker payload');
    }

    return currentWorkerData.filePath.trim();
}

async function runPdfConformanceWorker() {
    if (!parentPort) {
        throw new Error('PDF conformance worker started without a parentPort');
    }

    try {
        const filePath = resolveWorkerFilePath();
        const data = await analyzePdfConformanceFileDirect(filePath);
        const payload: TPdfConformanceWorkerResult = {
            type: 'result',
            ok: true,
            data,
        };
        parentPort.postMessage(payload);
    } catch (error) {
        const payload: TPdfConformanceWorkerResult = {
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
        };
        parentPort.postMessage(payload);
    } finally {
        parentPort.close();
    }
}

await runPdfConformanceWorker();
