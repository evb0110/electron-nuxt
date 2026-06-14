import {
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    clearSessionStarting,
    getSessionStartingInfo,
    markSessionStarting,
    recordSessionStartingAttempt,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    sessionDir,
    sessionStartingFilePath,
    setCurrentSessionName,
} from '@scripts/electron-run/electronRunSessionPaths';

const testSessionName = `unit-artifacts-${process.pid}`;

function resetTestSession() {
    setCurrentSessionName(testSessionName);
    rmSync(sessionDir(), {
        recursive: true,
        force: true,
    });
}

describe('electron run session artifacts', () => {
    afterEach(() => {
        resetTestSession();
        setCurrentSessionName('default');
    });

    it('records pre-ready Electron launch attempt metadata in the starting artifact', () => {
        resetTestSession();

        markSessionStarting(12345);
        recordSessionStartingAttempt({
            cdpPorts: [
                9222,
                9222,
            ],
            electronPids: [
                23456,
                23456,
            ],
            electronUserDataDir: electronUserDataPath(),
            nuxtPid: 34567,
            nuxtPort: 3235,
        });

        expect(getSessionStartingInfo()).toMatchObject({
            pid: 12345,
            cdpPorts: [9222],
            electronPids: [23456],
            electronUserDataDir: electronUserDataPath(),
            nuxtPid: 34567,
            nuxtPort: 3235,
        });
    });

    it('normalizes legacy starting artifacts that only contain the manager pid', () => {
        resetTestSession();
        mkdirSync(sessionDir(), {recursive: true});
        writeFileSync(sessionStartingFilePath(), JSON.stringify({
            pid: 12345,
            startedAt: Date.now(),
        }));

        expect(getSessionStartingInfo()).toMatchObject({
            pid: 12345,
            cdpPorts: [],
            electronPids: [],
            electronUserDataDir: null,
            nuxtPid: null,
            nuxtPort: null,
        });

        clearSessionStarting();
    });
});
