import {
    readFile,
    stat,
    writeFile,
} from 'node:fs/promises';
import { buildPrintablePdfData } from '@pdf-core';
import { PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES } from '@contracts/shared';
import {
    decodePdfPrintLayoutUtilityRequest,
    type TPdfPrintLayoutUtilityResult,
} from '@electron/features/documents/main/pdfPrintLayoutUtilityProtocol';
import { getErrorMessage } from '@electron/utils/error';

interface IUtilityParentPort {
    once(eventName: string, listener: (event: {data: unknown}) => void): unknown;
    postMessage(value: unknown): void;
}

function isUtilityParentPort(value: unknown): value is IUtilityParentPort {
    return typeof value === 'object'
        && value !== null
        && 'once' in value
        && typeof value.once === 'function'
        && 'postMessage' in value
        && typeof value.postMessage === 'function';
}

const rawParentPort: unknown = process.parentPort;
if (!isUtilityParentPort(rawParentPort)) {
    throw new Error('PDF print layout utility started without a parent port');
}
const utilityParentPort = rawParentPort;

utilityParentPort.once('message', (event) => {
    void (async () => {
        const request = decodePdfPrintLayoutUtilityRequest(event.data);
        if (!request) {
            throw new Error('Invalid PDF print layout utility request');
        }
        const inputStat = await stat(request.inputPath);
        if (
            !inputStat.isFile()
            || !Number.isSafeInteger(inputStat.size)
            || inputStat.size <= 0
            || inputStat.size > PDF_PATH_PRINT_LAYOUT_MAX_SOURCE_BYTES
        ) {
            throw new Error('PDF is too large for advanced print layout');
        }
        const sourceData = new Uint8Array(await readFile(request.inputPath));
        const printableData = await buildPrintablePdfData(sourceData, {
            viewMode: request.viewMode,
            orientation: request.orientation,
            ...(request.pageNumbers === undefined ? {} : {pageNumbers: request.pageNumbers}),
        });
        if (!printableData) {
            throw new Error('PDF print layout produced no pages');
        }
        await writeFile(request.outputPath, printableData, {flag: 'wx'});
        const result: TPdfPrintLayoutUtilityResult = {
            type: 'result',
            ok: true,
            bytes: printableData.byteLength,
        };
        utilityParentPort.postMessage(result);
    })().catch((error: unknown) => {
        const result: TPdfPrintLayoutUtilityResult = {
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
        };
        utilityParentPort.postMessage(result);
    });
});
