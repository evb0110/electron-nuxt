import type { IShapeAnnotation } from '@app/types/annotations';
import type { TDocumentRef } from '@contracts/documentRef';
import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { assertEmbeddedShapeImportSize } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/embeddedShapeImportLimit';
import { readDocumentBytes } from '@app/utils/documentBytes';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';

const EMBEDDED_SHAPE_IMPORT_TIMEOUT_MS = 90_000;
const EMBEDDED_SHAPE_IMPORT_PATH_CHUNK_BYTES = 4 * 1024 * 1024;

interface IEmbeddedShapeImportWorkerResponse {
    ok: boolean;
    shapes?: IShapeAnnotation[];
    error?: string;
}

function canUseEmbeddedShapeImportWorker() {
    return typeof window !== 'undefined' && typeof Worker !== 'undefined';
}

function createTransferableView(data: Uint8Array, transferOwnership: boolean) {
    if (
        transferOwnership
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data;
    }
    return data.slice();
}

function createEmbeddedShapeImportWorker(
    signal: AbortSignal | undefined,
    dispatch: (worker: Worker, operationSignal: AbortSignal) => void | Promise<void>,
) {
    const worker = new Worker(
        new URL('./importEmbeddedShapeAnnotations.worker.ts', import.meta.url),
        { type: 'module' },
    );

    return new Promise<IShapeAnnotation[]>((resolve, reject) => {
        const timeoutError = new Error('Embedded PDF shape import worker timed out');
        const operationController = new AbortController();
        let settled = false;
        const abortFromCaller = () => {
            operationController.abort(signal?.reason instanceof Error
                ? signal.reason
                : new DOMException('Embedded PDF shape import aborted', 'AbortError'));
        };
        const timeout = setTimeout(() => {
            operationController.abort(timeoutError);
        }, EMBEDDED_SHAPE_IMPORT_TIMEOUT_MS);
        const settle = (callback: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            operationController.signal.removeEventListener('abort', abort);
            signal?.removeEventListener('abort', abortFromCaller);
            worker.terminate();
            callback();
        };
        const abort = () => {
            settle(() => reject(operationController.signal.reason instanceof Error
                ? operationController.signal.reason
                : new DOMException('Embedded PDF shape import aborted', 'AbortError')));
        };

        worker.onmessage = (event: MessageEvent<IEmbeddedShapeImportWorkerResponse>) => {
            const response = event.data;
            if (response.ok && Array.isArray(response.shapes)) {
                settle(() => resolve(response.shapes!));
                return;
            }
            settle(() => reject(new Error(response.error ?? 'Embedded PDF shape import worker failed')));
        };
        worker.onerror = event => {
            settle(() => reject(new Error(event.message || 'Embedded PDF shape import worker failed')));
        };
        operationController.signal.addEventListener('abort', abort, { once: true });
        signal?.addEventListener('abort', abortFromCaller, { once: true });
        if (signal?.aborted) {
            abortFromCaller();
            return;
        }
        Promise.resolve()
            .then(() => {
                operationController.signal.throwIfAborted();
                return dispatch(worker, operationController.signal);
            })
            .catch(error => settle(() => reject(error)));
    });
}

export async function importEmbeddedShapeAnnotationsUsingWorker(
    data: Uint8Array,
    options: {
        signal?: AbortSignal;
        transferOwnership?: boolean;
    } = {},
): Promise<IShapeAnnotation[]> {
    options.signal?.throwIfAborted();
    assertEmbeddedShapeImportSize(data.byteLength);
    if (!canUseEmbeddedShapeImportWorker()) {
        return importEmbeddedShapeAnnotations(data);
    }

    // Path-backed imports pass a disposable read buffer and can transfer it
    // directly. Byte-backed sessions retain canonical renderer state, so the
    // default remains an owned copy that does not detach the caller.
    const transferableData = createTransferableView(data, options.transferOwnership === true);

    return createEmbeddedShapeImportWorker(options.signal, worker => {
        worker.postMessage({
            type: 'bytes',
            data: transferableData,
        }, [transferableData.buffer]);
    });
}

export async function importEmbeddedShapeAnnotationsFromPathInWorker(
    path: TDocumentRef,
    options: {signal?: AbortSignal} = {},
): Promise<IShapeAnnotation[]> {
    options.signal?.throwIfAborted();
    if (!canUseEmbeddedShapeImportWorker()) {
        const bytes = options.signal
            ? await readDocumentBytes(path, {signal: options.signal})
            : await readDocumentBytes(path);
        return importEmbeddedShapeAnnotations(bytes);
    }

    const files = getDocumentFilesCapability();
    const {size} = await files.statFile(path);
    assertEmbeddedShapeImportSize(size);
    options.signal?.throwIfAborted();
    return createEmbeddedShapeImportWorker(options.signal, async (worker, operationSignal) => {
        worker.postMessage({
            type: 'path-start',
            size,
        });
        for (let offset = 0; offset < size; offset += EMBEDDED_SHAPE_IMPORT_PATH_CHUNK_BYTES) {
            operationSignal.throwIfAborted();
            const length = Math.min(EMBEDDED_SHAPE_IMPORT_PATH_CHUNK_BYTES, size - offset);
            const chunk = await files.readFileRange(path, offset, length);
            operationSignal.throwIfAborted();
            if (chunk.byteLength !== length) {
                throw new Error(`Document changed while importing embedded shapes: expected ${length} bytes, read ${chunk.byteLength} bytes`);
            }
            const transferableChunk = createTransferableView(chunk, true);
            worker.postMessage({
                type: 'path-chunk',
                offset,
                data: transferableChunk,
            }, [transferableChunk.buffer]);
        }
        operationSignal.throwIfAborted();
        worker.postMessage({type: 'path-finish'});
    });
}
