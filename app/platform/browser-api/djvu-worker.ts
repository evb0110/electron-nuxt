import type { TDocumentRef } from '@contracts/platform-api';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browser-document-store';
import { loadDjvuJs } from '@app/platform/browser-api/djvujs-loader';
import { readDocumentBytes } from '@app/utils/document-bytes';

function toOwnedArrayBuffer(bytes: Uint8Array) {
    if (
        bytes.buffer instanceof ArrayBuffer
        && bytes.byteOffset === 0
        && bytes.byteLength === bytes.buffer.byteLength
    ) {
        return bytes.buffer;
    }

    return bytes.slice().buffer;
}

export async function createDjvuWorkerFromPath(djvuPath: TDocumentRef) {
    const djvuGlobal = await loadDjvuJs();
    const worker = new djvuGlobal.Worker();
    const bytes = await readDocumentBytes(djvuPath);
    const buffer = toOwnedArrayBuffer(bytes);

    await worker.createDocument(buffer, {});
    if (isBrowserDocumentRef(djvuPath)) {
        browserDocumentStore.unload(djvuPath);
    }
    return worker;
}
