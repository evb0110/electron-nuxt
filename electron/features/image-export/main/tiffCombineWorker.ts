import {
    parentPort,
    workerData,
} from 'worker_threads';
import { combinePagesIntoMultiPageTiffLocal } from '@electron/features/image-export/main/combinePagesIntoMultiPageTiffLocal';
import type { IWorkerTaskErrorFrame } from '@electron/utils/workerTask';
import { createWorkerTaskErrorFrame } from '@electron/utils/workerTask';
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
        errorFrame?: IWorkerTaskErrorFrame;
    };

interface ITiffCombineWorkerCancelMessage {type: 'cancel';}

function getWorkerInput() {
    const input = workerData as ITiffCombineWorkerData | undefined;
    if (!Array.isArray(input?.pagePaths) || typeof input.outputPath !== 'string') {
        throw new Error('Invalid TIFF combine worker payload');
    }
    const pagePaths: string[] = [];
    for (const [
        index,
        path,
    ] of input.pagePaths.entries()) {
        if (typeof path !== 'string' || path.trim().length === 0) {
            throw new Error(`Invalid TIFF combine page path at index ${index}`);
        }
        pagePaths.push(path);
    }
    if (pagePaths.length === 0) {
        throw new Error('TIFF combine worker requires at least one page path');
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
            errorFrame: createWorkerTaskErrorFrame(error, {source: 'image-export:tiff-combine-worker'}),
        } satisfies TTiffCombineWorkerResult);
    }
}

await run();
