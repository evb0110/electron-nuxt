import { join } from 'node:path';
import {
    isProcessAlive,
    killProcessTree,
    waitForProcessExit,
} from '@scripts/electron-run/electronRunProcessTree';
import { getSessionInfo } from '@scripts/electron-run/electronRunSessionArtifacts';
import { sessionDir } from '@scripts/electron-run/electronRunSessionPaths';
import { startElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import type { IElectronE2ESession } from '@tests/e2e/electron/helpers/startElectronE2ESession';
import { applyStressHostProfile } from '@scripts/stress/applyStressHostProfile';
import type { IAppliedStressHostProfile } from '@scripts/stress/applyStressHostProfile';
import { buildStressProfileSessionEnv } from '@scripts/stress/stressHostProfiles';
import { sweepLeakedSessionProcesses } from '@scripts/stress/stressOracles';
import type { IStressHostProfile } from '@scripts/stress/stressTypes';

export interface IStressSessionHandle {
    session: IElectronE2ESession;
    profile: IStressHostProfile;
    applied: IAppliedStressHostProfile;
    electronPid: number | null;
    userDataDir: string;
    startedAtEpochMs: number;
    /** Stops the app, waits for the process tree, and returns whatever survived. */
    stop: () => Promise<{leakedPids: number[]}>;
}

const PROCESS_EXIT_TIMEOUT_MS = 20_000;
const FORCE_KILL_GRACE_MS = 1_500;

/** Session names are scoped by the E2E run id, so two stress runs never share a user-data dir. */
export function buildStressSessionName(scenarioId: string) {
    const slug = scenarioId.toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40);
    return `stress-${slug || 'scenario'}`;
}

/**
 * One Electron per scenario: the profile's Chromium switches are process
 * arguments, and a fresh user-data dir keeps tab-restore state from one
 * scenario out of the next.
 */
export async function startStressSession(scenarioId: string, profile: IStressHostProfile, log: (line: string) => void): Promise<IStressSessionHandle> {
    const name = buildStressSessionName(scenarioId);
    log(`starting Electron session ${name} with profile ${profile.id}`);
    const session = await startElectronE2ESession(name, {
        clean: true,
        extraEnv: buildStressProfileSessionEnv(profile),
    });
    const info = getSessionInfo(session.name);
    const electronPid = info?.electronPid ?? null;
    const userDataDir = join(sessionDir(session.name), 'electron-user-data');
    let applied: IAppliedStressHostProfile;
    try {
        applied = await applyStressHostProfile(session.page, profile);
    } catch (error) {
        log(`profile ${profile.id} could not be applied; stopping session ${session.name}`);
        await session.stop({preserveArtifacts: true}).catch(() => undefined);
        if (electronPid !== null && isProcessAlive(electronPid)) {
            await killProcessTree(electronPid, FORCE_KILL_GRACE_MS, {force: true});
        }
        throw error;
    }
    log(`session ${session.name} ready (electron pid ${electronPid ?? 'unknown'})`);
    let stopped = false;
    return {
        session,
        profile,
        applied,
        electronPid,
        userDataDir,
        startedAtEpochMs: Date.now(),
        async stop() {
            if (stopped) {
                return {leakedPids: []};
            }
            stopped = true;
            try {
                await applied.release();
            } catch (error) {
                log(`profile release failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            try {
                await session.stop({preserveArtifacts: true});
            } catch (error) {
                log(`session stop failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            if (electronPid !== null && isProcessAlive(electronPid)) {
                try {
                    const exited = await waitForProcessExit(electronPid, PROCESS_EXIT_TIMEOUT_MS);
                    if (!exited) {
                        log(`electron pid ${electronPid} still alive after stop; killing its tree`);
                        await killProcessTree(electronPid, FORCE_KILL_GRACE_MS, {force: true});
                    }
                } catch (error) {
                    log(`electron pid ${electronPid} cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
            const leakedPids = sweepLeakedSessionProcesses(userDataDir);
            if (leakedPids.length > 0) {
                log(`leaked processes for ${userDataDir}: ${leakedPids.join(', ')}`);
                for (const pid of leakedPids) {
                    try {
                        await killProcessTree(pid, FORCE_KILL_GRACE_MS, {force: true});
                    } catch (error) {
                        log(`leaked pid ${pid} kill failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
            }
            return {leakedPids};
        },
    };
}
