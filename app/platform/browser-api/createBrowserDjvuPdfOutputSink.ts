import type { TDocumentRef } from '@contracts/documentRef';
import {
    BROWSER_DOCUMENT_CHUNK_SIZE,
    browserDocumentStore,
} from '@app/platform/browserDocumentStore';
import type { IStreamingPdfSink } from '@app/platform/browser-api/streamingImagePdfWriter';
import { toOwnedArrayBuffer } from '@app/platform/browser-api/browserDjvuCanvas';

interface IFinalizablePdfSink extends IStreamingPdfSink {
    finish(): Promise<TDocumentRef>;
    abort(): Promise<void>;
}

class BrowserChunkedPdfSink implements IFinalizablePdfSink {
    private readonly buffer: Uint8Array;
    private chunkIndex = 0;
    private bufferedBytes = 0;
    private fileSize = 0;

    public constructor(
        private readonly outputPath: TDocumentRef,
        private readonly saveName: string,
        private readonly chunkSize = BROWSER_DOCUMENT_CHUNK_SIZE,
    ) {
        this.buffer = new Uint8Array(chunkSize);
    }

    public async init() {
        await browserDocumentStore.prepareChunkedDocument(this.outputPath, { chunkSize: this.chunkSize });
    }

    public async write(bytes: Uint8Array) {
        let readOffset = 0;
        this.fileSize += bytes.byteLength;
        while (readOffset < bytes.byteLength) {
            const writeLength = Math.min(this.chunkSize - this.bufferedBytes, bytes.byteLength - readOffset);
            this.buffer.set(bytes.subarray(readOffset, readOffset + writeLength), this.bufferedBytes);
            this.bufferedBytes += writeLength;
            readOffset += writeLength;
            if (this.bufferedBytes === this.chunkSize) {
                await browserDocumentStore.writeChunk(this.outputPath, this.chunkIndex, this.buffer);
                this.chunkIndex += 1;
                this.bufferedBytes = 0;
            }
        }
    }

    public async finish() {
        if (this.bufferedBytes > 0) {
            await browserDocumentStore.writeChunk(
                this.outputPath,
                this.chunkIndex,
                this.buffer.slice(0, this.bufferedBytes),
            );
            this.chunkIndex += 1;
            this.bufferedBytes = 0;
        }
        await browserDocumentStore.finalizeChunkedDocument(this.outputPath, {
            fileSize: this.fileSize,
            chunkCount: this.chunkIndex,
            chunkSize: this.chunkSize,
            saveName: this.saveName,
        });
        await browserDocumentStore.setRetention(this.outputPath, 'durable');
        browserDocumentStore.unload(this.outputPath);
        return this.outputPath;
    }

    public async abort() {
        await browserDocumentStore.clearChunkedDocument(this.outputPath);
    }
}

class BrowserHandlePdfSink implements IFinalizablePdfSink {
    private fileSize = 0;

    private constructor(
        private readonly outputPath: TDocumentRef,
        private readonly saveHandle: FileSystemFileHandle,
        private readonly saveName: string,
        private readonly writable: FileSystemWritableFileStream,
    ) {}

    public static async create(
        outputPath: TDocumentRef,
        saveHandle: FileSystemFileHandle,
        saveName: string,
    ) {
        return new BrowserHandlePdfSink(outputPath, saveHandle, saveName, await saveHandle.createWritable());
    }

    public async write(bytes: Uint8Array) {
        this.fileSize += bytes.byteLength;
        await this.writable.write(toOwnedArrayBuffer(bytes));
    }

    public async finish() {
        await this.writable.close();
        await browserDocumentStore.replaceWithHandleBackedDocument(this.outputPath, {
            fileSize: this.fileSize,
            saveHandle: this.saveHandle,
            saveName: this.saveName,
        });
        await browserDocumentStore.setRetention(this.outputPath, 'durable');
        browserDocumentStore.unload(this.outputPath);
        return this.outputPath;
    }

    public async abort() {
        if (typeof this.writable.abort === 'function') {
            await this.writable.abort();
        }
    }
}

export async function createBrowserDjvuPdfOutputSink(outputPath: TDocumentRef) {
    const saveTarget = await browserDocumentStore.getSaveTarget(outputPath);
    if (saveTarget.saveHandle) {
        return BrowserHandlePdfSink.create(outputPath, saveTarget.saveHandle, saveTarget.saveName);
    }
    const sink = new BrowserChunkedPdfSink(outputPath, saveTarget.saveName);
    await sink.init();
    return sink;
}
