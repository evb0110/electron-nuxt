import { spawn } from 'node:child_process';
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
    vi,
} from 'vitest';
import {
    isElectronRunCommand,
    parseElectronRunCommandRequest,
} from '@scripts/electron-run/electronRunProtocol';
import {
    inspectProcessIdentity,
    killVerifiedSessionProcess,
} from '@scripts/electron-run/electronRunProcessIdentity';
import type * as TElectronRunProcessTree from '@scripts/electron-run/electronRunProcessTree';
import {
    shouldRemoveSessionStopArtifacts,
    stopSingleSession,
} from '@scripts/electron-run/stopSession';
import {
    clearAutomationWorkspaceCrashCheckpoint,
    workspaceCrashCheckpointPath,
} from '@scripts/electron-run/electronRunWorkspaceCheckpoint';
import {
    sessionDir,
    sessionFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {
    clearAutomationWorkspaceCrashCheckpointAfterSessionExit,
    shouldClearAutomationWorkspaceCrashCheckpointOnExit,
} from '@scripts/electron-run/sessionController';

const processTree = vi.hoisted(() => ({isProcessAlive: vi.fn<(pid: number) => boolean>()}));

vi.mock('@scripts/electron-run/electronRunProcessTree', async importOriginal => ({
    ...await importOriginal<typeof TElectronRunProcessTree>(),
    isProcessAlive: processTree.isProcessAlive,
}));

const projectRoot = process.cwd();

// Above Linux's default pid_max, so it can never name a live host process.
const UNUSED_PID = 4_194_305;

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
        const sessionSource = readProjectSource('scripts/electron-run/sessionController.ts');
        const stopSource = readProjectSource('scripts/electron-run/stopSession.ts');
        const gracefulCloseIndex = sessionSource.indexOf('electronAPI?.windowTabs.closeCurrentWindow');
        const browserFallbackIndex = sessionSource.indexOf('state.browser.close()');
        const electronFallbackIndex = sessionSource.indexOf('killSpawnedProcessTree(state.electronProcess');
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
        const sessionSource = readProjectSource('scripts/electron-run/sessionController.ts');
        const startBody = sessionSource.slice(
            sessionSource.indexOf('export async function startControlledSession('),
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

    it('treats a process that exits while its identity is read as terminated, not refused', async () => {
        // A session process can exit between the liveness gate and the `ps`
        // read that establishes ownership, which makes it indistinguishable
        // from an unrelated PID. Reporting that as a refusal strands the
        // session directory and forces a second stop, so a PID that is gone
        // by the time identity is unavailable must count as terminated.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);

        try {
            await expect(killVerifiedSessionProcess({
                pid: UNUSED_PID,
                expectation: {
                    kind: 'controller',
                    sessionName: 'exit-during-identity-read',
                },
            })).resolves.toBe(true);
            expect(warn).not.toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    it('removes session artifacts when the controller exits while its identity is read', async () => {
        const sessionName = `stop-race-policy-${String(process.pid)}-${String(Date.now())}`;
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockReturnValueOnce(true).mockReturnValue(false);
        try {
            mkdirSync(sessionDir(sessionName), {recursive: true});
            writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                port: 45_001,
                pid: UNUSED_PID,
                cdpPort: 45_002,
                electronPid: null,
                nuxtPid: null,
                nuxtPort: 45_003,
            }), 'utf8');

            await expect(stopSingleSession(sessionName)).resolves.toBeUndefined();
            expect(existsSync(sessionFilePath(sessionName))).toBe(false);
        } finally {
            rmSync(sessionDir(sessionName), {
                recursive: true,
                force: true,
            });
        }
    });

    it('refuses to terminate a live process whose identity does not match the session', async () => {
        // Exercised against a real, still-running process so the refusal comes
        // from a successfully read identity that fails ownership matching,
        // rather than from an absent PID that yields no identity at all. The
        // child runs from the project root, so it clears the project-identity
        // half of the controller check and can only be rejected on the
        // controller entry point itself.
        const {isProcessAlive} = await vi.importActual<typeof TElectronRunProcessTree>(
            '@scripts/electron-run/electronRunProcessTree',
        );
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        processTree.isProcessAlive.mockReset();
        processTree.isProcessAlive.mockImplementation(isProcessAlive);

        const unrelated = spawn(process.execPath, [
            '-e',
            'setTimeout(() => {}, 30000)',
        ], {stdio: 'ignore'});
        const unrelatedPid = unrelated.pid ?? 0;
        try {
            expect(unrelatedPid).toBeGreaterThan(0);
            await vi.waitFor(() => {
                expect(inspectProcessIdentity(unrelatedPid)).not.toBeNull();
            });

            await expect(killVerifiedSessionProcess({
                pid: unrelatedPid,
                expectation: {
                    kind: 'controller',
                    sessionName: 'unrelated-live-process',
                },
            })).resolves.toBe(false);
            expect(isProcessAlive(unrelatedPid)).toBe(true);
            expect(warn).toHaveBeenCalledWith(expect.stringContaining('Refused to terminate'));
        } finally {
            warn.mockRestore();
            unrelated.kill('SIGKILL');
        }
    });
});
