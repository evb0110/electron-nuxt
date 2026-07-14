import {
    existsSync,
    mkdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {
    dirname,
    join,
} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    isElectronRunCommand,
    parseElectronRunCommandRequest,
} from '@scripts/electron-run/electronRunProtocol';
import { shouldRemoveSessionStopArtifacts } from '@scripts/electron-run/stopSession';
import {
    clearAutomationWorkspaceCrashCheckpoint,
    workspaceCrashCheckpointPath,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import { sessionDir } from '@scripts/electron-run/electronRunSessionPaths';
import {
    clearAutomationWorkspaceCrashCheckpointAfterSessionExit,
    shouldClearAutomationWorkspaceCrashCheckpointOnExit,
} from '@scripts/electron-run/sessionManager';

const projectRoot = process.cwd();

function readProjectSource(path: string) {
    return readFileSync(join(projectRoot, path), 'utf8');
}

describe('Electron automation graceful shutdown policy', () => {
    it('exposes a controller-owned shutdown command', () => {
        expect(isElectronRunCommand('shutdown')).toBe(true);
        expect(parseElectronRunCommandRequest({
            command: 'shutdown',
            args: [],
        })).toEqual({
            command: 'shutdown',
            args: [],
        });
    });

    it('closes the renderer window before browser and process-tree fallbacks', () => {
        const sessionSource = readProjectSource('scripts/electron-run/sessionManager.ts');
        const stopSource = readProjectSource('scripts/electron-run/stopSession.ts');
        const gracefulCloseIndex = sessionSource.indexOf('electronAPI?.windowTabs.closeCurrentWindow');
        const browserFallbackIndex = sessionSource.indexOf('state.browser.close()');
        const electronFallbackIndex = sessionSource.indexOf('killProcessTree(electronPid');
        const shutdownCommandIndex = stopSource.indexOf('info, \'shutdown\'');
        const controllerFallbackIndex = stopSource.indexOf('killVerifiedSessionProcess', shutdownCommandIndex);

        expect(gracefulCloseIndex).toBeGreaterThan(-1);
        expect(browserFallbackIndex).toBeGreaterThan(gracefulCloseIndex);
        expect(electronFallbackIndex).toBeGreaterThan(browserFallbackIndex);
        expect(shutdownCommandIndex).toBeGreaterThan(-1);
        expect(controllerFallbackIndex).toBeGreaterThan(shutdownCommandIndex);
        expect(sessionSource).toContain('Graceful app shutdown complete');
        expect(sessionSource).toContain('Graceful shutdown timed out; using process-tree fallback');
    });

    it('removes only the crash-recovery checkpoint on an intentional automation stop', () => {
        const sessionName = `checkpoint-policy-${String(process.pid)}-${String(Date.now())}`;
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        try {
            mkdirSync(dirname(checkpointPath), {recursive: true});
            writeFileSync(checkpointPath, '{"checkpoint":true}', 'utf8');

            expect(clearAutomationWorkspaceCrashCheckpoint(sessionName)).toBe(true);
            expect(clearAutomationWorkspaceCrashCheckpoint(sessionName)).toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('preserves crash recovery during a normal start until an explicit stop owns cleanup', () => {
        const sessionSource = readProjectSource('scripts/electron-run/sessionManager.ts');
        const startBody = sessionSource.slice(
            sessionSource.indexOf('export async function startSession('),
            sessionSource.indexOf('async function waitForProcessExit', sessionSource.indexOf('export async function startSession(')),
        );

        expect(startBody).not.toContain('clearAutomationWorkspaceCrashCheckpoint');
        expect(sessionSource).toContain('130,');
        expect(sessionSource).toContain('143,');
        expect(readProjectSource('scripts/electron-run/stopSession.ts'))
            .toContain('clearAutomationWorkspaceCrashCheckpoint(name)');
    });

    it('clears restart checkpoints for controlled exits while retaining genuine crash recovery', () => {
        const sessionName = `restart-checkpoint-policy-${String(process.pid)}-${String(Date.now())}`;
        const checkpointPath = workspaceCrashCheckpointPath(sessionName);
        try {
            mkdirSync(dirname(checkpointPath), {recursive: true});
            writeFileSync(checkpointPath, '{"checkpoint":true}', 'utf8');

            expect(shouldClearAutomationWorkspaceCrashCheckpointOnExit(1)).toBe(false);
            expect(clearAutomationWorkspaceCrashCheckpointAfterSessionExit(1, sessionName)).toBe(false);
            expect(existsSync(checkpointPath)).toBe(true);

            expect(shouldClearAutomationWorkspaceCrashCheckpointOnExit(130)).toBe(true);
            expect(shouldClearAutomationWorkspaceCrashCheckpointOnExit(143)).toBe(true);
            expect(clearAutomationWorkspaceCrashCheckpointAfterSessionExit(143, sessionName)).toBe(true);
            expect(existsSync(checkpointPath)).toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('keeps the E2E browser attached until the controller initiates app shutdown', () => {
        const source = readProjectSource('tests/e2e/electron/helpers/startElectronE2ESession.ts');
        const stopStart = source.indexOf('const stop = async (');
        expect(stopStart).toBeGreaterThan(-1);
        const stopBody = source.slice(
            stopStart,
            source.indexOf('return {', stopStart),
        );

        expect(stopBody).toContain('stopSingleSession(scopedSessionName');
        expect(stopBody).not.toContain('browser.disconnect()');
    });

    it('retains session artifacts whenever any verified termination is refused', () => {
        expect(shouldRemoveSessionStopArtifacts([
            true,
            true,
            true,
        ])).toBe(true);
        expect(shouldRemoveSessionStopArtifacts([
            false,
            true,
            true,
        ])).toBe(false);
        expect(shouldRemoveSessionStopArtifacts([
            true,
            false,
            true,
        ])).toBe(false);
        expect(shouldRemoveSessionStopArtifacts([
            true,
            true,
            false,
        ])).toBe(false);

        const stopSource = readProjectSource('scripts/electron-run/stopSession.ts');
        const refusalBranch = stopSource.slice(
            stopSource.indexOf('if (!shouldRemoveSessionStopArtifacts(outcomes))'),
            stopSource.indexOf('removeSessionStopFiles(name);'),
        );
        expect(refusalBranch).toContain('retainSessionStopArtifacts(name, info)');
        expect(refusalBranch).toContain('throw new Error');
    });
});
