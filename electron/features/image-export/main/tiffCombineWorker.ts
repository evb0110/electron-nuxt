import {
    parentPort,
    workerData,
} from 'worker_threads';
import { combinePagesIntoMultiPageTiffLocal } from '@electron/features/image-export/main/tiffCombineLocal';
import { getErrorMessage } from '@electron/utils/error';

interface ITiffCombineWorkerData {
    pagePaths?: unknown;
    outputPath?: unknown;
}

type TTiffCombineWorkerResult =
    | {
        type: 'result';
        ok: true;
    }
    | {
        type: 'result';
        ok: false;
        error: string;
    };

function getWorkerInput() {
    const input = workerData as ITiffCombineWorkerData | undefined;
    if (!Array.isArray(input?.pagePaths) || typeof input.outputPath !== 'string') {
        throw new Error('Invalid TIFF combine worker payload');
    }
    return {
        pagePaths: input.pagePaths.filter((path): path is string => typeof path === 'string'),
        outputPath: input.outputPath,
    };
}

async function run() {
    if (!parentPort) {
        throw new Error('TIFF combine worker started without a parentPort');
    }

    try {
        const input = getWorkerInput();
        await combinePagesIntoMultiPageTiffLocal(input.pagePaths, input.outputPath);
        parentPort.postMessage({
            type: 'result',
            ok: true,
        } satisfies TTiffCombineWorkerResult);
    } catch (error) {
        parentPort.postMessage({
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
        } satisfies TTiffCombineWorkerResult);
    }
}

await run();
