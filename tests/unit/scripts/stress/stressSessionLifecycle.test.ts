import { join } from 'node:path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type * as TStressOracles from '@scripts/stress/stressOracles';
import {
    buildStressSessionName,
    startStressSession,
} from '@scripts/stress/stressSessionLifecycle';
import {
    buildStressProfileSessionEnv,
    resolveStressHostProfile,
} from '@scripts/stress/stressHostProfiles';

const mocks = vi.hoisted(() => ({
    startElectronE2ESession: vi.fn(),
    getSessionInfo: vi.fn(),
    sessionDir: vi.fn((name: string) => `/sessions/${name}`),
    isProcessAlive: vi.fn(),
    killProcessTree: vi.fn(),
    waitForProcessExit: vi.fn(),
    applyStressHostProfile: vi.fn(),
    sweepLeakedSessionProcesses: vi.fn(),
}));

vi.mock('@tests/e2e/electron/helpers/startElectronE2ESession', () => ({startElectronE2ESession: mocks.startElectronE2ESession}));
vi.mock('@scripts/electron-run/electronRunSessionArtifacts', () => ({getSessionInfo: mocks.getSessionInfo}));
vi.mock('@scripts/electron-run/electronRunSessionPaths', () => ({sessionDir: mocks.sessionDir}));
vi.mock('@scripts/electron-run/electronRunProcessTree', () => ({
    isProcessAlive: mocks.isProcessAlive,
    killProcessTree: mocks.killProcessTree,
    waitForProcessExit: mocks.waitForProcessExit,
}));
vi.mock('@scripts/stress/applyStressHostProfile', () => ({applyStressHostProfile: mocks.applyStressHostProfile}));
vi.mock('@scripts/stress/stressOracles', async importOriginal => ({
    ...await importOriginal<typeof TStressOracles>(),
    sweepLeakedSessionProcesses: mocks.sweepLeakedSessionProcesses,
}));

const ELECTRON_PID = 4_194_301;

function createSession() {
    return {
        name: 'stress-open-xlarge',
        page: {},
        stop: vi.fn(async () => undefined),
    };
}

function createApplied() {
    return {
        profile: resolveStressHostProfile('baseline'),
        cdpSession: {},
        release: vi.fn(async () => undefined),
    };
}

describe('buildStressSessionName', () => {
    it('slugs the scenario id, caps its length, and never returns an empty slug', () => {
        expect(buildStressSessionName('Open XLarge!! Sparse')).toBe('stress-open-xlarge-sparse');
        expect(buildStressSessionName('---')).toBe('stress-scenario');
        expect(buildStressSessionName('x'.repeat(60))).toBe(`stress-${'x'.repeat(40)}`);
    });
});

describe('startStressSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getSessionInfo.mockReturnValue({electronPid: ELECTRON_PID});
        mocks.isProcessAlive.mockReturnValue(false);
        mocks.waitForProcessExit.mockResolvedValue(true);
        mocks.killProcessTree.mockResolvedValue(undefined);
        mocks.sweepLeakedSessionProcesses.mockReturnValue([]);
    });

    it('launches a clean session with the profile env and applies the profile to its page', async () => {
        const session = createSession();
        const applied = createApplied();
        mocks.startElectronE2ESession.mockResolvedValue(session);
        mocks.applyStressHostProfile.mockResolvedValue(applied);
        const profile = resolveStressHostProfile('slow-a');
        const log = vi.fn();

        const handle = await startStressSession('open-xlarge', profile, log);

        expect(mocks.startElectronE2ESession).toHaveBeenCalledWith('stress-open-xlarge', {
            clean: true,
            extraEnv: buildStressProfileSessionEnv(profile),
        });
        expect(mocks.applyStressHostProfile).toHaveBeenCalledWith(session.page, profile);
        expect(handle.electronPid).toBe(ELECTRON_PID);
        expect(handle.userDataDir).toBe(join('/sessions/stress-open-xlarge', 'electron-user-data'));
        expect(handle.applied).toBe(applied);
        expect(log).toHaveBeenCalledWith(expect.stringContaining(`electron pid ${ELECTRON_PID}`));
    });

    it('stops the app and kills a surviving Electron when the profile cannot be applied', async () => {
        const session = createSession();
        const failure = new Error('CDP refused');
        mocks.startElectronE2ESession.mockResolvedValue(session);
        mocks.applyStressHostProfile.mockRejectedValue(failure);
        mocks.isProcessAlive.mockReturnValue(true);

        await expect(startStressSession('open-xlarge', resolveStressHostProfile('slow-a'), vi.fn())).rejects.toBe(failure);

        expect(session.stop).toHaveBeenCalledWith({preserveArtifacts: true});
        expect(mocks.killProcessTree).toHaveBeenCalledWith(ELECTRON_PID, expect.any(Number), {force: true});
    });

    it('releases the profile, stops the session, and kills whatever the stop left behind', async () => {
        const session = createSession();
        const applied = createApplied();
        mocks.startElectronE2ESession.mockResolvedValue(session);
        mocks.applyStressHostProfile.mockResolvedValue(applied);
        mocks.isProcessAlive.mockReturnValue(true);
        mocks.waitForProcessExit.mockResolvedValue(false);
        mocks.sweepLeakedSessionProcesses.mockReturnValue([4_194_302]);
        const log = vi.fn();

        const handle = await startStressSession('open-xlarge', resolveStressHostProfile('baseline'), log);
        const stopped = await handle.stop();

        expect(applied.release).toHaveBeenCalledTimes(1);
        expect(session.stop).toHaveBeenCalledWith({preserveArtifacts: true});
        expect(mocks.waitForProcessExit).toHaveBeenCalledWith(ELECTRON_PID, expect.any(Number));
        expect(mocks.killProcessTree).toHaveBeenNthCalledWith(1, ELECTRON_PID, expect.any(Number), {force: true});
        expect(mocks.killProcessTree).toHaveBeenNthCalledWith(2, 4_194_302, expect.any(Number), {force: true});
        expect(mocks.sweepLeakedSessionProcesses).toHaveBeenCalledWith(handle.userDataDir);
        expect(stopped).toEqual({leakedPids: [4_194_302]});

        expect(await handle.stop()).toEqual({leakedPids: []});
        expect(session.stop).toHaveBeenCalledTimes(1);
    });

    it('logs release, stop, and cleanup failures instead of throwing from stop', async () => {
        const session = createSession();
        session.stop.mockRejectedValue(new Error('stop exploded'));
        const applied = createApplied();
        applied.release.mockRejectedValue(new Error('release exploded'));
        mocks.startElectronE2ESession.mockResolvedValue(session);
        mocks.applyStressHostProfile.mockResolvedValue(applied);
        mocks.isProcessAlive.mockReturnValue(true);
        mocks.waitForProcessExit.mockRejectedValue(new Error('wait exploded'));
        mocks.sweepLeakedSessionProcesses.mockReturnValue([4_194_303]);
        mocks.killProcessTree.mockRejectedValue(new Error('kill exploded'));
        const log = vi.fn();

        const handle = await startStressSession('open-xlarge', resolveStressHostProfile('baseline'), log);
        const stopped = await handle.stop();

        expect(stopped).toEqual({leakedPids: [4_194_303]});
        const lines = log.mock.calls.map(([line]) => line);
        expect(lines).toContain('profile release failed: release exploded');
        expect(lines).toContain('session stop failed: stop exploded');
        expect(lines).toContain(`electron pid ${ELECTRON_PID} cleanup failed: wait exploded`);
        expect(lines).toContain('leaked pid 4194303 kill failed: kill exploded');
    });
});
