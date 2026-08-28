import {spawn} from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import {join} from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {isProcessAlive} from '@scripts/electron-run/electronRunProcessTree';
import {
    electronUserDataPath,
    sessionDir,
    sessionFilePath,
} from '@scripts/electron-run/electronRunSessionPaths';
import {stopSingleSession} from '@scripts/electron-run/stopSession';

// Above Linux's default pid_max, so it can never name a live host process.
const UNUSED_PID = 4_194_305;
const RECORDED_CDP_PORT = 65_001;
const STRAY_CDP_PORT = 65_002;

async function forceKillAndWait(child: ReturnType<typeof spawn>) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolve) => {
        const onExit = () => resolve();
        child.once('exit', onExit);
        if (!child.kill('SIGKILL')) {
            child.off('exit', onExit);
            resolve();
        }
    });
}

// Carries the session's automation entry and user-data directory like a real
// Electron main process, but a CDP port the session file never recorded: the
// shape of an Electron that outlived a restart with a fresh port.
function spawnStraySessionElectron(sessionName: string) {
    const automationAppEntry = join(sessionDir(sessionName), 'automation-electron-app-entry', 'automation-app');
    const child = spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000); process.stdout.write("ready\\n");',
        '--',
        automationAppEntry,
        `--user-data-dir=${electronUserDataPath(sessionName)}`,
        `--remote-debugging-port=${String(STRAY_CDP_PORT)}`,
    ], {stdio: [
        'ignore',
        'pipe',
        'ignore',
    ]});
    const ready = new Promise<void>((resolve, reject) => {
        child.stdout?.once('data', () => resolve());
        child.once('error', reject);
        child.once('exit', (code, signal) => reject(new Error(
            `stray child exited before readiness (code ${String(code)}, signal ${String(signal)})`,
        )));
    });
    return {
        child,
        ready,
    };
}

describe('Electron automation stop residue', () => {
    it.runIf(process.platform !== 'win32')(
        'fails a stop that leaves a session-owned Electron process alive and retains the session',
        async () => {
            const sessionName = `stop-residue-${String(process.pid)}-${String(Date.now())}`;
            const stray = spawnStraySessionElectron(sessionName);
            try {
                await stray.ready;
                mkdirSync(sessionDir(sessionName), {recursive: true});
                writeFileSync(sessionFilePath(sessionName), JSON.stringify({
                    port: 1,
                    pid: UNUSED_PID,
                    cdpPort: RECORDED_CDP_PORT,
                    electronPid: null,
                    nuxtPid: null,
                    nuxtPort: 3_999,
                }));

                const failure = await stopSingleSession(sessionName).catch((error: unknown) => error);

                expect(failure).toBeInstanceOf(Error);
                expect((failure as Error).message).toContain(String(stray.child.pid));
                expect((failure as Error).message).toMatch(/Electron process/u);
                expect(existsSync(sessionFilePath(sessionName)), 'session artifacts are retained').toBe(true);
                expect(isProcessAlive(stray.child.pid ?? 0), 'the assertion reports residue, it does not hide it').toBe(true);
            } finally {
                await forceKillAndWait(stray.child);
                rmSync(sessionDir(sessionName), {
                    recursive: true,
                    force: true,
                });
            }
        },
        30_000,
    );
});
