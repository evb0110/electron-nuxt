import {
    open,
    rename,
    unlink,
} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {
    basename,
    dirname,
    join,
} from 'node:path';

export interface IScanCleanupCacheIdentityInput {
    sourcePath: string;
    sourceSha256: string;
    sourceSize: bigint | number | string;
    sourceMtimeNs: bigint | number | string;
}

export interface IScanCleanupCacheMetadataFileHandle {
    close: () => Promise<void>;
    sync: () => Promise<void>;
    writeFile: (value: string, encoding: 'utf8') => Promise<void>;
}

export interface IScanCleanupCacheMetadataFileSystem {
    open: (path: string, flags: 'r' | 'w') => Promise<IScanCleanupCacheMetadataFileHandle>;
    rename: (sourcePath: string, targetPath: string) => Promise<void>;
    unlink: (path: string) => Promise<void>;
}

export interface IScanCleanupCacheMetadataWriteOptions {fileSystem?: Partial<IScanCleanupCacheMetadataFileSystem>;}

const defaultFileSystem: IScanCleanupCacheMetadataFileSystem = {
    open: async (path, flags) => open(path, flags),
    rename,
    unlink,
};

export function createScanCleanupCacheIdentity(input: IScanCleanupCacheIdentityInput) {
    return JSON.stringify([
        input.sourcePath,
        String(input.sourceSize),
        String(input.sourceMtimeNs),
        input.sourceSha256,
    ]);
}

export async function writeScanCleanupCacheMetadata(
    metadataPath: string,
    metadata: string,
    options: IScanCleanupCacheMetadataWriteOptions = {},
) {
    const fileSystem: IScanCleanupCacheMetadataFileSystem = {
        ...defaultFileSystem,
        ...options.fileSystem,
    };
    const temporaryPath = join(
        dirname(metadataPath),
        `.${basename(metadataPath)}.${randomUUID()}.tmp`,
    );
    let temporaryHandle: IScanCleanupCacheMetadataFileHandle | null = null;
    try {
        temporaryHandle = await fileSystem.open(temporaryPath, 'w');
        await temporaryHandle.writeFile(metadata, 'utf8');
        await temporaryHandle.sync();
        await temporaryHandle.close();
        temporaryHandle = null;
        await fileSystem.rename(temporaryPath, metadataPath);
        if (process.platform !== 'win32') {
            const directoryHandle = await fileSystem.open(dirname(metadataPath), 'r');
            try {
                await directoryHandle.sync();
            } finally {
                await directoryHandle.close();
            }
        }
    } finally {
        await temporaryHandle?.close().catch(() => undefined);
        await fileSystem.unlink(temporaryPath).catch(() => undefined);
    }
}
