import {
    parentPort,
    workerData,
} from 'worker_threads';
import type {
    TCropWorkerInput,
    TCropWorkerResult,
} from '@electron/features/page-ops/main/cropWorkerProtocol';
import {
    cropPagesLocal,
    getPageGeometryLocal,
    removeCropFromPagesLocal,
} from '@electron/features/page-ops/main/cropLocal';
import { getErrorMessage } from '@electron/utils/error';

function getInput(): TCropWorkerInput {
    const input = workerData as TCropWorkerInput | undefined;
    if (!input || typeof input !== 'object' || typeof input.type !== 'string') {
        throw new Error('Invalid crop worker payload');
    }
    return input;
}

async function run() {
    if (!parentPort) {
        throw new Error('Crop worker started without a parentPort');
    }

    try {
        const input = getInput();
        switch (input.type) {
            case 'crop':
                await cropPagesLocal(input.workingCopyPath, input.pages, input.margins);
                parentPort.postMessage({
                    type: 'result',
                    ok: true,
                } satisfies TCropWorkerResult);
                break;
            case 'removeCrop':
                await removeCropFromPagesLocal(input.workingCopyPath, input.pages);
                parentPort.postMessage({
                    type: 'result',
                    ok: true,
                } satisfies TCropWorkerResult);
                break;
            case 'getPageGeometry':
                parentPort.postMessage({
                    type: 'result',
                    ok: true,
                    data: await getPageGeometryLocal(
                        input.workingCopyPath,
                        input.pageNumber,
                    ),
                } satisfies TCropWorkerResult);
                break;
            default:
                throw new Error(`Unsupported crop worker task: ${(input as { type: string }).type}`);
        }
    } catch (error) {
        parentPort.postMessage({
            type: 'result',
            ok: false,
            error: getErrorMessage(error),
        } satisfies TCropWorkerResult);
    }
}

await run();
