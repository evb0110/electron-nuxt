import type { TDocumentRef } from '@contracts/platform-api';

export interface IExternalDocumentReader {
    readRange(offset: number, length: number): Promise<Uint8Array>;
    read?(): Promise<Uint8Array>;
}

const readers = new Map<TDocumentRef, IExternalDocumentReader>();

export function registerExternalDocumentReader(
    ref: TDocumentRef,
    reader: IExternalDocumentReader,
) {
    readers.set(ref, reader);
    return () => {
        if (readers.get(ref) === reader) {
            readers.delete(ref);
        }
    };
}

export function getExternalDocumentReader(ref: TDocumentRef) {
    return readers.get(ref) ?? null;
}

