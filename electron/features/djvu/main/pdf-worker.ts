import {
    parentPort,
    workerData,
} from 'worker_threads';
import { buildOptimizedPdf } from '@electron/djvu/pdf-builder';
import { embedBookmarksIntoPdfFile } from '@electron/djvu/pdf-bookmarks';
import type {
    TDjvuPdfWorkerMessage,
    TDjvuPdfWorkerTask,
} from '@electron/features/djvu/main/pdf-worker-protocol';

function getTask(): TDjvuPdfWorkerTask {
    const task = workerData as TDjvuPdfWorkerTask | undefined;
    if (!task || typeof task !== 'object' || typeof task.type !== 'string') {
        throw new Error('Invalid DjVu PDF worker payload');
    }
    return task;
}

function toTransferableBuffer(data: Uint8Array): ArrayBuffer {
    if (
        data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data.buffer;
    }

    const clone = new Uint8Array(data.byteLength);
    clone.set(data);
    return clone.buffer;
}

async function runTask(task: TDjvuPdfWorkerTask) {
    switch (task.type) {
        case 'buildPdf':
            return buildOptimizedPdf(task.imagePaths, task.dpi, (page, total) => {
                parentPort?.postMessage({
                    type: 'progress',
                    phase: 'buildPdf',
                    page,
                    total,
                } satisfies TDjvuPdfWorkerMessage);
            });
        case 'estimatePdfSize': {
            const pdfBytes = await buildOptimizedPdf([task.imagePath], task.dpi);
            return pdfBytes.length;
        }
        case 'embedBookmarksInFile':
            return embedBookmarksIntoPdfFile(task.inputPdfPath, task.outputPdfPath, task.bookmarks);
        default:
            throw new Error(`Unsupported DjVu PDF worker task: ${(task as { type: string }).type}`);
    }
}

async function run() {
    if (!parentPort) {
        throw new Error('DjVu PDF worker started without a parentPort');
    }

    try {
        const task = getTask();
        const result = await runTask(task);
        if (typeof result === 'number') {
            parentPort.postMessage({
                type: 'result',
                ok: true,
                data: result,
            } satisfies TDjvuPdfWorkerMessage);
            return;
        }

        const transferableBuffer = toTransferableBuffer(result);
        parentPort.postMessage({
            type: 'result',
            ok: true,
            data: transferableBuffer,
        } satisfies TDjvuPdfWorkerMessage, [transferableBuffer]);
    } catch (error) {
        parentPort.postMessage({
            type: 'result',
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        } satisfies TDjvuPdfWorkerMessage);
    }
}

await run();
