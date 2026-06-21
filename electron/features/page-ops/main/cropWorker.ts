import {
    parentPort,
    workerData,
} from 'worker_threads';
import type {
    ICropWorkerCancelMessage,
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

function isCancelMessage(message: unknown): message is ICropWorkerCancelMessage {
    return Boolean(message)
        && typeof message === 'object'
        && (message as {type?: unknown}).type === 'cancel';
}

async function run() {
    if (!parentPort) {
        throw new Error('Crop worker started without a parentPort');
    }

    const abortController = new AbortController();
    parentPort.on('message', (message: unknown) => {
        if (isCancelMessage(message)) {
            abortController.abort(new DOMException('Crop worker canceled', 'AbortError'));
        }
    });

    try {
        const input = getInput();
        switch (input.type) {
            case 'crop':
                await cropPagesLocal(input.workingCopyPath, input.pages, input.margins, abortController.signal);
                parentPort.postMessage({
                    type: 'result',
                    ok: true,
                } satisfies TCropWorkerResult);
                break;
            case 'removeCrop':
                await removeCropFromPagesLocal(input.workingCopyPath, input.pages, abortController.signal);
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
