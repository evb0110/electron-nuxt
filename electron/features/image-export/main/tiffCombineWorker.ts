import {
    parentPort,
    workerData,
} from 'worker_threads';
import { combinePagesIntoMultiPageTiffLocal } from '@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal';
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

interface ITiffCombineWorkerCancelMessage {type: 'cancel';}

function getWorkerInput() {
    const input = workerData as ITiffCombineWorkerData | undefined;
    if (!Array.isArray(input?.pagePaths) || typeof input.outputPath !== 'string') {
        throw new Error('Invalid TIFF combine worker payload');
    }
    const pagePaths: string[] = [];
    for (const path of input.pagePaths) {
        if (typeof path === 'string') {
            pagePaths.push(path);
        }
    }
    return {
        pagePaths,
        outputPath: input.outputPath,
    };
}

function isCancelMessage(message: unknown): message is ITiffCombineWorkerCancelMessage {
    return Boolean(message)
        && typeof message === 'object'
        && (message as {type?: unknown}).type === 'cancel';
}

async function run() {
    if (!parentPort) {
        throw new Error('TIFF combine worker started without a parentPort');
    }

    const abortController = new AbortController();
    parentPort.on('message', (message: unknown) => {
        if (isCancelMessage(message)) {
            abortController.abort(new DOMException('TIFF combine worker canceled', 'AbortError'));
        }
    });

    try {
        const input = getWorkerInput();
        await combinePagesIntoMultiPageTiffLocal(input.pagePaths, input.outputPath, abortController.signal);
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
