import {
    readdirSync,
    readFileSync,
    rmSync,
} from 'fs';
import {
    readFile,
    readdir,
    rm,
} from 'fs/promises';
import {join} from 'path';
import {isErrnoException} from '@contracts/runtimeGuards';

interface IAssistantChatSnapshotReference {
    type: 'session-snapshot-ref';
    blobFile: string;
}

function isSnapshotReference(value: unknown): value is IAssistantChatSnapshotReference {
    return typeof value === 'object'
        && value !== null
        && (value as {type?: unknown}).type === 'session-snapshot-ref'
        && typeof (value as {blobFile?: unknown}).blobFile === 'string';
}

function addSnapshotBlobReferences(
    contents: string,
    parseRecord: (line: string) => unknown,
    references: Set<string>,
) {
    for (const rawLine of contents.split(/\r?\n/u)) {
        const record = parseRecord(rawLine.trim());
        if (isSnapshotReference(record)) {
            references.add(record.blobFile);
        }
    }
}

export async function collectAssistantChatSnapshotBlobReferences(
    directories: readonly string[],
    parseRecord: (line: string) => unknown,
) {
    const references = new Set<string>();
    for (const directory of directories) {
        let entries;
        try {
            entries = await readdir(directory, {withFileTypes: true});
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(directory, entry.name);
            try {
                addSnapshotBlobReferences(await readFile(filePath, 'utf8'), parseRecord, references);
            } catch (error) {
                if (isErrnoException(error) && error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
        }
    }
    return references;
}

export function collectAssistantChatSnapshotBlobReferencesSync(
    directories: readonly string[],
    parseRecord: (line: string) => unknown,
) {
    const references = new Set<string>();
    for (const directory of directories) {
        let entries;
        try {
            entries = readdirSync(directory, {withFileTypes: true});
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                continue;
            }
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
                continue;
            }
            const filePath = join(directory, entry.name);
            try {
                addSnapshotBlobReferences(readFileSync(filePath, 'utf8'), parseRecord, references);
            } catch (error) {
                if (isErrnoException(error) && error.code === 'ENOENT') {
                    continue;
                }
                throw error;
            }
        }
    }
    return references;
}

export async function pruneAssistantChatSnapshotBlobs(
    directories: readonly string[],
    blobsDir: string,
    parseRecord: (line: string) => unknown,
    onError?: (message: string, error: unknown) => void,
) {
    const referencedBlobFiles = await collectAssistantChatSnapshotBlobReferences(directories, parseRecord);
    let entries;
    try {
        entries = await readdir(blobsDir, {withFileTypes: true});
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || referencedBlobFiles.has(entry.name)) {
            continue;
        }
        const filePath = join(blobsDir, entry.name);
        try {
            await rm(filePath, {force: true});
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                continue;
            }
            try {
                onError?.(`Failed to prune assistant chat snapshot blob "${filePath}"`, error);
            } catch {
                // Error reporting cannot stop the remaining housekeeping work.
            }
        }
    }
}

export function pruneAssistantChatSnapshotBlobsSync(
    directories: readonly string[],
    blobsDir: string,
    parseRecord: (line: string) => unknown,
    onError?: (message: string, error: unknown) => void,
) {
    const referencedBlobFiles = collectAssistantChatSnapshotBlobReferencesSync(directories, parseRecord);
    let entries;
    try {
        entries = readdirSync(blobsDir, {withFileTypes: true});
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return;
        }
        throw error;
    }
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || referencedBlobFiles.has(entry.name)) {
            continue;
        }
        const filePath = join(blobsDir, entry.name);
        try {
            rmSync(filePath, {force: true});
        } catch (error) {
            if (isErrnoException(error) && error.code === 'ENOENT') {
                continue;
            }
            try {
                onError?.(`Failed to prune assistant chat snapshot blob "${filePath}"`, error);
            } catch {
                // Error reporting cannot stop the remaining housekeeping work.
            }
        }
    }
}
