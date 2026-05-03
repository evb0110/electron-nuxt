import {
    existsSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
} from 'fs';
import { join } from 'path';
import { app } from 'electron';
import { getErrorMessage } from '@electron/utils/error';

const SERVER_OWNERSHIP_FILE = 'nuxt-server-owner.json';

export interface IServerOwnershipMarker {
    pid: number;
    entryPath: string;
    port?: number;
    createdAt: number;
    version: 1;
}

interface IOwnershipMarkerConfig {
    entryPath: string;
    port: number;
}
type TOwnershipMarkerLogger = (msg: string) => void;

function getOwnershipMarkerPath() {
    return join(app.getPath('userData'), SERVER_OWNERSHIP_FILE);
}

export function readOwnershipMarker(): IServerOwnershipMarker | null {
    const markerPath = getOwnershipMarkerPath();
    if (!existsSync(markerPath)) {
        return null;
    }

    try {
        const content = readFileSync(markerPath, 'utf-8');
        const parsed = JSON.parse(content) as Partial<IServerOwnershipMarker>;
        if (
            typeof parsed?.pid !== 'number'
            || !Number.isInteger(parsed.pid)
            || parsed.pid <= 0
            || typeof parsed.entryPath !== 'string'
        ) {
            return null;
        }

        return {
            pid: parsed.pid,
            entryPath: parsed.entryPath,
            port: typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0
                ? parsed.port
                : undefined,
            createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
            version: 1,
        };
    } catch {
        return null;
    }
}

export function writeOwnershipMarker(
    pid: number,
    markerConfig: IOwnershipMarkerConfig,
    warn: TOwnershipMarkerLogger,
) {
    if (!Number.isInteger(pid) || pid <= 0) {
        return;
    }

    const markerPath = getOwnershipMarkerPath();
    const marker: IServerOwnershipMarker = {
        pid,
        entryPath: markerConfig.entryPath,
        port: markerConfig.port,
        createdAt: Date.now(),
        version: 1,
    };
    try {
        writeFileSync(markerPath, JSON.stringify(marker), 'utf-8');
    } catch (err) {
        warn(`Failed to write server ownership marker: ${getErrorMessage(err)}`);
    }
}

export function clearOwnershipMarker(warn: TOwnershipMarkerLogger) {
    const markerPath = getOwnershipMarkerPath();
    try {
        if (existsSync(markerPath)) {
            unlinkSync(markerPath);
        }
    } catch (err) {
        warn(`Failed to clear server ownership marker: ${getErrorMessage(err)}`);
    }
}
