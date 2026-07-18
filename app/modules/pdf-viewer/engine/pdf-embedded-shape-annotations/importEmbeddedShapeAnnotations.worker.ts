import { importEmbeddedShapeAnnotations } from '@app/modules/pdf-viewer/engine/pdf-embedded-shape-annotations/importEmbeddedShapeAnnotations';
import { getErrorMessage } from '@app/utils/error';

const EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES = 96 * 1024 * 1024;

type TEmbeddedShapeImportWorkerRequest =
    | {
        type: 'bytes';
        data: Uint8Array
    }
    | {
        type: 'path-start';
        size: number
    }
    | {
        type: 'path-chunk';
        offset: number;
        data: Uint8Array
    }
    | {type: 'path-finish'};

let pathData: Uint8Array | null = null;

self.addEventListener('message', async (event: MessageEvent<TEmbeddedShapeImportWorkerRequest>) => {
    try {
        if (event.data.type === 'path-start') {
            if (
                !Number.isSafeInteger(event.data.size)
                || event.data.size < 0
                || event.data.size > EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES
            ) {
                throw new RangeError('Embedded shape import input exceeds the 96 MiB limit');
            }
            pathData = new Uint8Array(event.data.size);
            return;
        }
        if (event.data.type === 'path-chunk') {
            if (!pathData) {
                throw new Error('Embedded shape path import was not initialized');
            }
            if (
                !Number.isSafeInteger(event.data.offset)
                || event.data.offset < 0
                || event.data.offset + event.data.data.byteLength > pathData.byteLength
            ) {
                throw new RangeError('Embedded shape import chunk is outside the declared input');
            }
            pathData.set(event.data.data, event.data.offset);
            return;
        }
        const data = event.data.type === 'bytes' ? event.data.data : pathData;
        if (!data) {
            throw new Error('Embedded shape path import has no data');
        }
        if (data.byteLength > EMBEDDED_SHAPE_IMPORT_MAX_INPUT_BYTES) {
            throw new RangeError('Embedded shape import input exceeds the 96 MiB limit');
        }
        pathData = null;
        const shapes = await importEmbeddedShapeAnnotations(data);
        self.postMessage({
            ok: true,
            shapes,
        });
    } catch (error) {
        self.postMessage({
            ok: false,
            error: getErrorMessage(error),
        });
    }
});
