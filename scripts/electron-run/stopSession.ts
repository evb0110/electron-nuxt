import {
    mkdirSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { delay } from 'es-toolkit/promise';
import {
    cleanupOrphanedProjectNuxtRoots,
    hasOtherAliveSessionUsingNuxt,
    killExistingNuxt,
    readNuxtSessionShareMetadata,
} from '@scripts/electron-run/electronRunNuxtServer';
import {
    isProcessAlive,
    waitForProcessExit,
} from '@scripts/electron-run/electronRunProcessTree';
import {
    findSessionOwnedElectronPids,
    isVerifiedSessionProcess,
    killVerifiedSessionProcess,
    type ISessionProcessIdentityExpectation,
} from '@scripts/electron-run/electronRunProcessIdentity';
import {
    cleanupSessionStartingAttempt,
    clearSessionStarting,
    getSessionInfo,
    getSessionStartingInfo,
    listAllSessionNames,
} from '@scripts/electron-run/electronRunSessionArtifacts';
import {
    electronUserDataPath,
    getCurrentSessionName,
    sessionDir,
    sessionFilePath,
    sessionKeepNuxtMarkerPath,
} from '@scripts/electron-run/electronRunSessionPaths';
import type { ISessionInfo } from '@scripts/electron-run/electronRunSessionTypes';
import { sendCommandToSession } from '@scripts/electron-run/sendCommand';
import { clearAutomationWorkspaceCrashCheckpoint } from '@scripts/electron-run/electronRunWorkspaceCheckpoint';

const SESSION_CONTROLLER_SHUTDOWN_TIMEOUT_MS = 12_000;
const SESSION_SHUTDOWN_COMMAND_TIMEOUT_MS = 2_000;

interface IVerifiedTerminationResult {
    terminated: number;
    refused: number;
}

async function killVerifiedSessionProcesses(
    pids: Iterable<number>,
    expectation: ISessionProcessIdentityExpectation,
    graceMs: number,
): Promise<IVerifiedTerminationResult> {
    let terminated = 0;
    let refused = 0;
    for (const pid of new Set(pids)) {
        if (!isProcessAlive(pid)) {
            continue;
        }
        const didTerminate = await killVerifiedSessionProcess({
            pid,
            expectation,
            graceMs,
        });
        if (didTerminate) {
            terminated += 1;
        } else if (isProcessAlive(pid)) {
            refused += 1;
        }
    }
    return {
        terminated,
        refused,
    };
}

export function shouldRemoveSessionStopArtifacts(outcomes: readonly boolean[]) {
    return outcomes.every(Boolean);
}

async function stopSessionController(info: ISessionInfo, name: string, keepNuxt?: boolean) {
    if (keepNuxt && info.nuxtPid && isProcessAlive(info.nuxtPid)) {
        mkdirSync(sessionDir(name), {recursive: true});
        writeFileSync(sessionKeepNuxtMarkerPath(name), String(Date.now()));
    }
    if (!isProcessAlive(info.pid)) {
        return true;
    }
    if (!isVerifiedSessionProcess(info.pid, {
        kind: 'controller',
        sessionName: name,
    })) {
        // A controller that exited during the identity probe is stopped, not
        // unverifiable, and must not retain the session artifacts.
        return !isProcessAlive(info.pid);
    }

    try {
        await sendCommandToSession(info, 'shutdown', [], SESSION_SHUTDOWN_COMMAND_TIMEOUT_MS);
    } catch {
        const terminated = await killVerifiedSessionProcess({
            pid: info.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
            graceMs: 1500,
        });
        if (!terminated) {
            return false;
        }
    }
    if (await waitForProcessExit(info.pid, SESSION_CONTROLLER_SHUTDOWN_TIMEOUT_MS)) {
        return true;
    }
    if (isProcessAlive(info.pid)) {
        console.warn(`[Session '${name}'] Graceful controller shutdown timed out; using process-tree fallback`);
        return killVerifiedSessionProcess({
            pid: info.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
            graceMs: 1500,
        });
    }
    return true;
}

async function stopSessionElectron(info: ISessionInfo, name: string) {
    const expectation = {
        kind: 'electron',
        sessionName: name,
        cdpPort: info.cdpPort,
    } satisfies ISessionProcessIdentityExpectation;
    const candidates = new Set(findSessionOwnedElectronPids(expectation));
    if (info.electronPid) {
        candidates.add(info.electronPid);
    }
    const result = await killVerifiedSessionProcesses(candidates, expectation, 800);
    return result.refused === 0;
}

async function stopNuxtForSessionInfo(info: ISessionInfo, name: string, keepNuxt?: boolean) {
    if (!info.nuxtPid || !isProcessAlive(info.nuxtPid)) {
        return true;
    }
    if (keepNuxt) {
        console.log('[Nuxt] Left running for fast restart');
        return true;
    }
    if (hasOtherAliveSessionUsingNuxt(readNuxtSessionShareMetadata(), name, info.nuxtPid, info.nuxtPort)) {
        console.log('[Nuxt] Left running (shared with other session)');
        return true;
    }
    return killVerifiedSessionProcess({
        pid: info.nuxtPid,
        expectation: {
            kind: 'nuxt',
            sessionName: name,
            nuxtPort: info.nuxtPort,
        },
        graceMs: 1200,
    });
}

function removeSessionStopFiles(name: string) {
    try { unlinkSync(sessionFilePath(name)); } catch {}
    try { unlinkSync(sessionKeepNuxtMarkerPath(name)); } catch {}
}

async function killOrphanedSessionElectron(name: string) {
    const expectation = {
        kind: 'electron',
        sessionName: name,
        electronUserDataDir: electronUserDataPath(name),
    } satisfies ISessionProcessIdentityExpectation;
    const pids = findSessionOwnedElectronPids(expectation);
    return killVerifiedSessionProcesses(pids, expectation, 800);
}

function retainSessionStopArtifacts(name: string, info: ISessionInfo) {
    mkdirSync(sessionDir(name), {recursive: true});
    writeFileSync(sessionFilePath(name), JSON.stringify(info));
}

export async function stopSingleSession(name: string, options: {keepNuxt?: boolean} = {}) {
    const info = getSessionInfo(name);
    const starting = getSessionStartingInfo(name);
    if (!info && !starting) {
        const orphanResult = await killOrphanedSessionElectron(name);
        if (orphanResult.refused > 0) {
            throw new Error(
                `Session '${name}' could not terminate ${orphanResult.refused} Electron process(es): identity did not match session ownership, or the process outlived termination.`,
            );
        }
        if (orphanResult.terminated > 0) {
            await delay(250);
            console.log(`Cleaned ${orphanResult.terminated} orphaned Electron process(es) for session '${name}'.`);
        } else {
            console.log(`No session '${name}' running.`);
        }
        clearAutomationWorkspaceCrashCheckpoint(name);
        return;
    }
    if (info) {
        const outcomes = [
            await stopSessionController(info, name, options.keepNuxt),
            await stopSessionElectron(info, name),
            await stopNuxtForSessionInfo(info, name, options.keepNuxt),
        ];
        if (!shouldRemoveSessionStopArtifacts(outcomes)) {
            retainSessionStopArtifacts(name, info);
            throw new Error(
                `Session '${name}' stop was refused because one or more process identities could not be verified; session artifacts were retained.`,
            );
        }
        clearAutomationWorkspaceCrashCheckpoint(name);
        removeSessionStopFiles(name);
    }
    if (starting?.pid && isProcessAlive(starting.pid)) {
        const didTerminateStartingController = await killVerifiedSessionProcess({
            pid: starting.pid,
            expectation: {
                kind: 'controller',
                sessionName: name,
            },
            graceMs: 1000,
        });
        if (!didTerminateStartingController) {
            if (info) {
                retainSessionStopArtifacts(name, info);
            }
            throw new Error(
                `Session '${name}' startup-controller stop was refused; session artifacts were retained.`,
            );
        }
    }
    await cleanupSessionStartingAttempt(name, {killNuxt: options.keepNuxt !== true});
    clearSessionStarting(name);
    clearAutomationWorkspaceCrashCheckpoint(name);
    console.log(`Session '${name}' stopped.`);
}

export async function stopAllSessions() {
    await cleanupOrphanedProjectNuxtRoots('stop all sessions');
    const names = listAllSessionNames();
    if (names.length === 0) {
        await killExistingNuxt();
        await cleanupOrphanedProjectNuxtRoots('stop all sessions');
        console.log('No sessions found.');
        return;
    }
    for (const name of names) await stopSingleSession(name);
    await killExistingNuxt();
    await cleanupOrphanedProjectNuxtRoots('stop all sessions');
    console.log('All sessions stopped.');
}

export async function stopSession(options: {
    stopAll?: boolean;
    keepNuxt?: boolean
} = {}) {
    if (options.stopAll) {
        await stopAllSessions();
    } else {
        await stopSingleSession(getCurrentSessionName(), options.keepNuxt === undefined
            ? {}
            : {keepNuxt: options.keepNuxt});
    }
}
