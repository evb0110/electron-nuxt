import {renameSync} from 'node:fs';
import { rename } from 'node:fs/promises';
import { isErrnoException } from '@contracts/runtimeGuards';

function createQuarantinePath(filePath: string, nowMs = Date.now()) {
    return `${filePath}.${nowMs}.corrupt`;
}

export async function quarantineCorruptFile(filePath: string) {
    const quarantinePath = createQuarantinePath(filePath);
    try {
        await rename(filePath, quarantinePath);
        return quarantinePath;
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

export function quarantineCorruptFileSync(filePath: string) {
    const quarantinePath = createQuarantinePath(filePath);
    try {
        renameSync(filePath, quarantinePath);
        return quarantinePath;
    } catch (error) {
        if (isErrnoException(error) && error.code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
