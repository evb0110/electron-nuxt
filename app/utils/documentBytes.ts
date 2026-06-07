import type { TDocumentRef } from '@contracts/documentRef';
import { getDocumentsCapability } from '@app/utils/platformDocuments';

const DEFAULT_DOCUMENT_READ_CHUNK_BYTES = 4 * 1024 * 1024;

export interface IReadDocumentBytesOptions {
    chunkSize?: number;
    knownSize?: number;
    maxBytes?: number;
}

function normalizeChunkSize(value: number | undefined) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return DEFAULT_DOCUMENT_READ_CHUNK_BYTES;
    }

    return Math.max(64 * 1024, Math.floor(value));
}

async function resolveDocumentSize(path: TDocumentRef, knownSize: number | undefined) {
    if (typeof knownSize === 'number' && Number.isFinite(knownSize)) {
        return Math.max(0, Math.floor(knownSize));
    }

    return (await getDocumentsCapability().statFile(path)).size;
}

export async function readDocumentBytes(
    path: TDocumentRef,
    options: IReadDocumentBytesOptions = {},
) {
    const documents = getDocumentsCapability();
    const size = await resolveDocumentSize(path, options.knownSize);

    if (typeof options.maxBytes === 'number' && size > options.maxBytes) {
        throw new Error(`Document exceeds in-memory read limit (${options.maxBytes} bytes)`);
    }

    if (size <= 0) {
        return new Uint8Array();
    }

    const chunkSize = normalizeChunkSize(options.chunkSize);
    if (size <= chunkSize) {
        const data = await documents.readFile(path);
        return data instanceof Uint8Array ? data : new Uint8Array(data);
    }

    const output = new Uint8Array(size);
    let offset = 0;

    while (offset < size) {
        const nextChunkLength = Math.min(chunkSize, size - offset);
        const chunk = await documents.readFileRange(path, offset, nextChunkLength);
        output.set(chunk, offset);
        offset += chunk.byteLength;

        if (chunk.byteLength === 0) {
            break;
        }
    }

    if (offset === size) {
        return output;
    }

    return output.slice(0, offset);
}

export async function readDocumentBytesIfBelowLimit(
    path: TDocumentRef,
    maxBytes: number,
    options: Omit<IReadDocumentBytesOptions, 'maxBytes'> = {},
) {
    const size = await resolveDocumentSize(path, options.knownSize);
    if (size > maxBytes) {
        return null;
    }

    return readDocumentBytes(path, {
        ...options,
        knownSize: size,
        maxBytes,
    });
}
