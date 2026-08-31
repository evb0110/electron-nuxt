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

const { parentPort } = process;

if (!parentPort) {
    throw new Error('PDF print layout utility started without a parent port');
}

parentPort.once('message', (event) => {
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
        parentPort.postMessage(result);
    })().catch((error: unknown) => {
        const result: TPdfPrintLayoutUtilityResult = {
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
        };
        parentPort.postMessage(result);
    });
});
