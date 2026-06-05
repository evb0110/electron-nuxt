import {
    parentPort,
    workerData,
} from 'worker_threads';
import { buildOptimizedPdf } from '@electron/djvu/pdfBuilder';
import { embedBookmarksIntoPdfFile } from '@electron/djvu/pdfBookmarks';
import type {
    TDjvuPdfWorkerMessage,
    TDjvuPdfWorkerTask,
} from '@electron/features/djvu/main/pdfWorkerProtocol';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@electron/utils/error';

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function getTask(): TDjvuPdfWorkerTask {
    const task = workerData;
    if (!isRecord(task) || typeof task.type !== 'string') {
        throw new Error('Invalid DjVu PDF worker payload');
    }
    switch (task.type) {
        case 'buildPdf':
            if (!isStringArray(task.imagePaths) || !isFiniteNumber(task.dpi)) {
                throw new Error('Invalid DjVu PDF build task payload');
            }
            return {
                type: 'buildPdf',
                imagePaths: task.imagePaths,
                dpi: task.dpi,
            };
        case 'estimatePdfSize':
            if (typeof task.imagePath !== 'string' || !isFiniteNumber(task.dpi)) {
                throw new Error('Invalid DjVu PDF estimate task payload');
            }
            return {
                type: 'estimatePdfSize',
                imagePath: task.imagePath,
                dpi: task.dpi,
            };
        case 'embedBookmarksInFile':
            if (
                typeof task.inputPdfPath !== 'string'
                || typeof task.outputPdfPath !== 'string'
                || !Array.isArray(task.bookmarks)
            ) {
                throw new Error('Invalid DjVu PDF bookmark task payload');
            }
            return {
                type: 'embedBookmarksInFile',
                inputPdfPath: task.inputPdfPath,
                outputPdfPath: task.outputPdfPath,
                bookmarks: task.bookmarks,
            };
        default:
            throw new Error(`Unsupported DjVu PDF worker task: ${task.type}`);
    }
}

function toTransferableBuffer(data: Uint8Array) {
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
            error: getErrorMessage(error),
        } satisfies TDjvuPdfWorkerMessage);
    }
}

await run();
