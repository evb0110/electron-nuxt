import type { TDocumentRef } from '@contracts/platformApi';
import {
    browserDocumentStore,
    isBrowserDocumentRef,
} from '@app/platform/browserDocumentStore';
import { loadDjvuJs } from '@app/platform/browser-api/djvujsLoader';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

const DJVU_READ_CHUNK_BYTES = 4 * 1024 * 1024;

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

async function readBrowserDocumentBytes(path: TDocumentRef) {
    const { size } = await browserDocumentStore.stat(path);
    if (size <= 0) {
        return new Uint8Array();
    }

    if (size <= DJVU_READ_CHUNK_BYTES) {
        return browserDocumentStore.read(path);
    }

    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        const chunkLength = Math.min(DJVU_READ_CHUNK_BYTES, size - offset);
        const chunk = await browserDocumentStore.readRange(path, offset, chunkLength);
        output.set(chunk, offset);
        offset += chunk.byteLength;
        if (chunk.byteLength === 0) {
            break;
        }
    }

    return offset === size ? output : output.slice(0, offset);
}

async function readDesktopDocumentBytes(path: TDocumentRef) {
    const documents = getDocumentsCapability();
    const { size } = await documents.statFile(path);
    if (size <= 0) {
        return new Uint8Array();
    }

    if (size <= DJVU_READ_CHUNK_BYTES) {
        return documents.readFile(path);
    }

    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        const chunkLength = Math.min(DJVU_READ_CHUNK_BYTES, size - offset);
        const chunk = await documents.readFileRange(path, offset, chunkLength);
        output.set(chunk, offset);
        offset += chunk.byteLength;
        if (chunk.byteLength === 0) {
            break;
        }
    }

    return offset === size ? output : output.slice(0, offset);
}

export async function createDjvuWorkerFromPath(djvuPath: TDocumentRef) {
    const djvuGlobal = await loadDjvuJs();
    const worker = new djvuGlobal.Worker();
    const bytes = isBrowserDocumentRef(djvuPath)
        ? await readBrowserDocumentBytes(djvuPath)
        : await readDesktopDocumentBytes(djvuPath);
    const buffer = toOwnedArrayBuffer(bytes);

    await worker.createDocument(buffer, {});
    if (isBrowserDocumentRef(djvuPath)) {
        browserDocumentStore.unload(djvuPath);
    }
    return worker;
}
