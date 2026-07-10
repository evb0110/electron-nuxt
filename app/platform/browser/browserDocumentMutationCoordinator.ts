import type {IWriteDocumentOptions} from '@app/platform/browser/browserDocumentTypes';
import type {TDocumentRevisionToken} from '@contracts/documentRevision';
import type {BrowserDocumentMutationQueue} from '@app/platform/browser/browserDocumentMutationQueue';

export interface IBrowserDocumentMutation {
    write(
        data: Uint8Array | ArrayBuffer,
        options?: Omit<IWriteDocumentOptions, 'expectedDocumentRevisionToken' | 'skipDocumentRevisionCheckForBootstrap'>,
    ): Promise<boolean>;
    replaceWorkingCopySource(
        sourceRef: string,
        saveName: string,
        saveHandle?: FileSystemFileHandle | null,
    ): Promise<void>;
}

export interface IBrowserDocumentSourceMutation extends IBrowserDocumentMutation { writeSource(data: Uint8Array | ArrayBuffer): Promise<boolean>; }

interface IBrowserDocumentMutationCoordinatorOptions {
    assertRevision(ref: string, expectedRevision: TDocumentRevisionToken | null | undefined): Promise<void>;
    getSourceRef(ref: string): Promise<string>;
    writeUnlocked(
        ref: string,
        data: Uint8Array | ArrayBuffer,
        options: Omit<IWriteDocumentOptions, 'expectedDocumentRevisionToken' | 'skipDocumentRevisionCheckForBootstrap'>,
    ): Promise<boolean>;
    replaceSource(
        ref: string,
        sourceRef: string,
        saveName: string,
        saveHandle?: FileSystemFileHandle | null,
    ): Promise<void>;
}

export class BrowserDocumentMutationCoordinator {
    public constructor(
        private readonly queue: BrowserDocumentMutationQueue,
        private readonly options: IBrowserDocumentMutationCoordinatorOptions,
    ) {}

    private createMutation(ref: string): IBrowserDocumentMutation {
        return {
            write: (data, options = {}) => this.options.writeUnlocked(ref, data, options),
            replaceWorkingCopySource: (sourceRef, saveName, saveHandle) => (
                this.options.replaceSource(ref, sourceRef, saveName, saveHandle)
            ),
        };
    }

    public runWithSource<T>(
        ref: string,
        sourceRef: string,
        expectedRevision: TDocumentRevisionToken | null | undefined,
        operation: (mutation: IBrowserDocumentSourceMutation) => Promise<T>,
    ) {
        return this.queue.runMany([
            ref,
            sourceRef,
        ], async () => {
            if (await this.options.getSourceRef(ref) !== sourceRef) {
                throw new Error('Browser document source changed while the save target was being selected.');
            }
            await this.options.assertRevision(ref, expectedRevision);
            return operation({
                ...this.createMutation(ref),
                writeSource: data => this.options.writeUnlocked(sourceRef, data, {}),
            });
        });
    }
}
