import {
    rmSync,
    type RmOptions,
} from 'node:fs';
import {rm} from 'node:fs/promises';

const TEMP_DIRECTORY_REMOVE_OPTIONS = {
    force: true,
    maxRetries: 10,
    recursive: true,
    retryDelay: 50,
} as const satisfies RmOptions;

export async function removeTemporaryDirectory(directory: string) {
    await rm(directory, TEMP_DIRECTORY_REMOVE_OPTIONS);
}

export function removeTemporaryDirectorySync(directory: string) {
    rmSync(directory, TEMP_DIRECTORY_REMOVE_OPTIONS);
}
