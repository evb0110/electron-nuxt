import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    describeNonInteractiveSession,
    EXPECTED_INPUT_DESKTOP,
    isGuestIdentityProbePayload,
    normalizeWindowsArchitecture,
    parseGuestEnvironmentProbe,
    probeGuestEnvironment,
    type IGuestIdentityProbePayload,
} from '@scripts/windows-test/guest/guestIdentity';
import type {
    IGuestPowerShellRunner,
    TGuestPowerShellScriptName,
} from '@scripts/windows-test/guest/guestPowerShell';

function payload(overrides: Partial<IGuestIdentityProbePayload> = {}): IGuestIdentityProbePayload {
    return {
        userSid: 'S-1-5-21-1-2-3-1001',
        sessionId: 1,
        integrityLevel: 'Medium',
        inputDesktop: EXPECTED_INPUT_DESKTOP,
        logonUiPresent: false,
        workerPid: 4242,
        workerStartTime: '2026-09-04T12:00:00.000Z',
        osVersion: 'Windows 11 Pro 10.0.26100',
        osArchitecture: 'ARM64',
        hostname: 'evb-guest',
        appVersion: '1.4.2',
        ...overrides,
    };
}

interface IRecordedPowerShellCall {
    scriptName: TGuestPowerShellScriptName;
    args: readonly string[];
}

function fakePowerShell(response: unknown) {
    const calls: IRecordedPowerShellCall[] = [];
    const runner: IGuestPowerShellRunner = {
        scriptPath: scriptName => `C:\\evb-test\\worker\\powershell\\${scriptName}`,
        run: () => Promise.reject(new Error('run is not used by the identity probe')),
        runJson: (scriptName, args = []) => {
            calls.push({
                scriptName,
                args,
            });
            return Promise.resolve(response);
        },
    };
    return {
        runner,
        calls,
    };
}

describe('guest identity probe', () => {
    it('accepts a complete probe payload and rejects a partial one', () => {
        expect(isGuestIdentityProbePayload(payload())).toBe(true);
        expect(isGuestIdentityProbePayload({
            ...payload(),
            userSid: '',
        })).toBe(false);
        expect(isGuestIdentityProbePayload({
            ...payload(),
            sessionId: 'one',
        })).toBe(false);
    });

    it('normalizes the architecture names Windows reports', () => {
        expect(normalizeWindowsArchitecture('ARM64')).toBe('arm64');
        expect(normalizeWindowsArchitecture('AMD64')).toBe('x64');
        expect(normalizeWindowsArchitecture('x86_64')).toBe('x64');
        expect(normalizeWindowsArchitecture('x86')).toBeNull();
    });

    it('marks an interactive Default desktop session as interactive', () => {
        const probe = parseGuestEnvironmentProbe(payload());
        expect(probe.identity.interactive).toBe(true);
        expect(probe.osArch).toBe('arm64');
        expect(describeNonInteractiveSession(probe)).toBeNull();
    });

    it('refuses Session 0, a non-Default desktop and a locked session', () => {
        const sessionZero = parseGuestEnvironmentProbe(payload({ sessionId: 0 }));
        expect(sessionZero.identity.interactive).toBe(false);
        expect(describeNonInteractiveSession(sessionZero)).toContain('Session 0');

        const wrongDesktop = parseGuestEnvironmentProbe(payload({ inputDesktop: 'Winlogon' }));
        expect(describeNonInteractiveSession(wrongDesktop)).toContain('input desktop');

        const unavailableDesktop = parseGuestEnvironmentProbe(payload({ inputDesktop: '' }));
        expect(unavailableDesktop.identity.inputDesktop).toBe('unavailable');
        expect(describeNonInteractiveSession(unavailableDesktop)).toContain('unavailable');

        const locked = parseGuestEnvironmentProbe(payload({ logonUiPresent: true }));
        expect(locked.identity.interactive).toBe(false);
        expect(describeNonInteractiveSession(locked)).toContain('locked');
    });

    it('falls back to a readable app version when the executable reports none', () => {
        expect(parseGuestEnvironmentProbe(payload({ appVersion: '' })).appVersion).toBe('unknown');
    });

    it('throws on an unrecognized probe payload instead of guessing', () => {
        expect(() => parseGuestEnvironmentProbe({ userSid: 'S-1-5-21' }))
            .toThrow('unrecognized payload');
    });

    it('passes the executable path to probe-identity.ps1 as an argument, never inside a string', async () => {
        const executablePath = 'C:\\Users\\tester\\App\\EVB Viewer.exe';
        const powerShell = fakePowerShell(payload());
        const probe = await probeGuestEnvironment(powerShell.runner, executablePath);
        expect(probe.hostname).toBe('evb-guest');
        expect(powerShell.calls).toEqual([{
            scriptName: 'probe-identity.ps1',
            args: [executablePath],
        }]);
    });
});
