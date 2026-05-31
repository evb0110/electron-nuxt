import {
    isAbsolute,
    join,
} from 'node:path';
import { projectRoot } from '@scripts/electron-run/electronRunProjectPaths';

let currentSessionName = 'default';

export function validateSessionName(name: string) {
    if (!name || name === '.' || name === '..') {
        throw new Error('Session name must not be empty, "." or ".."');
    }
    if (name.includes('/') || name.includes('\\') || name.includes('..') || isAbsolute(name)) {
        throw new Error('Session name must not contain path separators or traversal segments');
    }
    return name;
}

export function getCurrentSessionName() {
    return currentSessionName;
}

export function setCurrentSessionName(name: string) {
    currentSessionName = validateSessionName(name);
}

export const sessionsBaseDir = join(projectRoot, '.devkit', 'sessions');

export function sessionDir(name = getCurrentSessionName()) {
    return join(sessionsBaseDir, validateSessionName(name));
}

export function sessionFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.json');
}

export function sessionStartingFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session-starting.json');
}

export function sessionLogFilePath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'session.log');
}

export function electronUserDataPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'electron-user-data');
}

export function screenshotDirPath(name = getCurrentSessionName()) {
    return join(sessionDir(name), 'screenshots');
}
