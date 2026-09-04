import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildLaunchArguments,
    createOwnedProcessRegistry,
    createWindowsAppLauncher,
    matchesOwnedProcess,
    readWindowsExecutableArchitecture,
    resolveInstalledExecutablePath,
    validateLaunchArguments,
    verifyInstalledExecutable,
    type IGuestProcessHandle,
    type IGuestProcessSpawner,
} from '@scripts/windows-test/guest/appLaunch';
import {
    createNodeGuestFileSystem,
    sha256Hex,
} from '@scripts/windows-test/guest/guestRuntime';

const fs = createNodeGuestFileSystem();

function portableExecutable(machine: number) {
    const bytes = new Uint8Array(512);
    bytes[0] = 0x4d;
    bytes[1] = 0x5a;
    const view = new DataView(bytes.buffer);
    view.setUint32(0x3c, 0x80, true);
    view.setUint32(0x80, 0x0000_4550, true);
    view.setUint16(0x84, machine, true);
    return bytes;
}

function fakeSpawner(pid: number) {
    const spawned: Array<{
        executable: string;
        args: readonly string[];
    }> = [];
    let alive = true;
    const handle: IGuestProcessHandle & { pid: number } = {
        pid,
        kill: () => {
            alive = false;
        },
        isAlive: () => alive,
    };
    const spawner: IGuestProcessSpawner = { spawn: (executable, args) => {
        spawned.push({
            executable,
            args,
        });
        return handle;
    } };
    return {
        spawned,
        spawner,
        handle,
    };
}

describe('guest application launch', () => {
    it('rejects security-policy overrides in both profiles', () => {
        for (const profile of [
            'instrumentation',
            'acceptance',
        ] as const) {
            const validation = validateLaunchArguments([
                '--no-sandbox',
                '--disable-features=IsolateOrigins,SitePerProcess',
            ], profile);
            expect(validation.allowed).toBe(false);
            expect(validation.violations).toHaveLength(2);
        }
    });

    it('rejects every instrumentation flag in the acceptance profile', () => {
        const validation = validateLaunchArguments([
            '--remote-debugging-port=9222',
            '--user-data-dir=C:\\evb-test\\work\\profile',
            '--enable-logging',
        ], 'acceptance');
        expect(validation.allowed).toBe(false);
        expect(validation.violations).toHaveLength(3);
    });

    it('accepts a bare acceptance launch with only a document path', () => {
        expect(buildLaunchArguments({
            profile: 'acceptance',
            documentPath: 'C:\\evb-test\\work\\run\\inputs\\вход-тест.pdf',
        })).toEqual(['C:\\evb-test\\work\\run\\inputs\\вход-тест.pdf']);
    });

    it('refuses a document path that the launcher would read as a switch', () => {
        expect(() => buildLaunchArguments({
            profile: 'acceptance',
            documentPath: '--remote-debugging-port=9222',
        })).toThrow('would be parsed as a launch switch');
    });

    it('requires a loopback port and an isolated profile for instrumentation', () => {
        expect(() => buildLaunchArguments({ profile: 'instrumentation' }))
            .toThrow('loopback debugging port');
        expect(buildLaunchArguments({
            profile: 'instrumentation',
            remoteDebuggingPort: 9333,
            userDataDirectory: 'C:\\evb-test\\work\\run\\profile',
        })).toEqual([
            '--remote-debugging-port=9333',
            '--user-data-dir=C:\\evb-test\\work\\run\\profile',
        ]);
    });

    it('resolves the per-user install path from the environment', () => {
        expect(resolveInstalledExecutablePath({ LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local' }))
            .toBe('C:\\Users\\tester\\AppData\\Local\\Programs\\EVB Viewer\\EVB Viewer.exe');
        expect(resolveInstalledExecutablePath({ EVB_WINDOWS_TEST_APP_EXECUTABLE: 'D:\\build\\EVB Viewer.exe' }))
            .toBe('D:\\build\\EVB Viewer.exe');
        expect(() => resolveInstalledExecutablePath({})).toThrow('LOCALAPPDATA');
    });

    it('reads the machine type out of a PE header', () => {
        expect(readWindowsExecutableArchitecture(portableExecutable(0xaa64))).toBe('arm64');
        expect(readWindowsExecutableArchitecture(portableExecutable(0x8664))).toBe('x64');
        expect(readWindowsExecutableArchitecture(portableExecutable(0x014c))).toBeNull();
        expect(readWindowsExecutableArchitecture(new Uint8Array([
            0x50,
            0x4b,
        ]))).toBeNull();
    });

    it('verifies the installed executable hash and architecture', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'evb-guest-exe-'));
        const executablePath = path.join(directory, 'EVB Viewer.exe');
        const bytes = portableExecutable(0xaa64);
        await fs.writeBytes(executablePath, bytes);

        const identity = await verifyInstalledExecutable({
            fs,
            executablePath,
            expectedArchitecture: 'arm64',
            expectedSha256: sha256Hex(bytes),
        });
        expect(identity.architecture).toBe('arm64');

        await expect(verifyInstalledExecutable({
            fs,
            executablePath,
            expectedArchitecture: 'x64',
        })).rejects.toThrow('but the job expects x64');

        await expect(verifyInstalledExecutable({
            fs,
            executablePath,
            expectedArchitecture: 'arm64',
            expectedSha256: 'e'.repeat(64),
        })).rejects.toThrow('does not match the expected record');
    });

    it('refuses to terminate a process it does not own', () => {
        const registry = createOwnedProcessRegistry();
        const owned = {
            pid: 4242,
            startTime: '2026-09-04T12:00:00.000Z',
            executable: 'C:\\Users\\tester\\App\\EVB Viewer.exe',
        };
        const fake = fakeSpawner(owned.pid);
        registry.register(owned, fake.handle);

        expect(registry.terminateOwned({
            ...owned,
            pid: 5,
        }).reason).toContain('not owned by this worker');
        expect(registry.terminateOwned({
            ...owned,
            startTime: '2026-09-04T13:00:00.000Z',
        }).reason).toContain('identity changed');
        expect(registry.terminateOwned({
            ...owned,
            executable: 'C:\\Windows\\System32\\notepad.exe',
        }).reason).toContain('identity changed');

        expect(matchesOwnedProcess(owned, { ...owned })).toBe(true);
        expect(registry.terminateOwned(owned).terminated).toBe(true);
        expect(registry.records()).toHaveLength(0);
        expect(registry.terminateOwned(owned).terminated).toBe(false);
    });

    it('records the launched process identity and only ever kills that record', () => {
        const fake = fakeSpawner(7788);
        const launcher = createWindowsAppLauncher({
            clock: {
                now: () => 1_700_000_000_000,
                nowIso: () => '2026-09-04T12:00:00.000Z',
                sleep: () => Promise.resolve(),
            },
            spawner: fake.spawner,
            registry: createOwnedProcessRegistry(),
            executable: {
                executablePath: 'C:\\Users\\tester\\App\\EVB Viewer.exe',
                sha256: 'f'.repeat(64),
                architecture: 'arm64',
            },
        });
        const record = launcher.launch({
            profile: 'instrumentation',
            remoteDebuggingPort: 9444,
            userDataDirectory: 'C:\\evb-test\\work\\run\\profile',
        });
        expect(record.browserUrl).toBe('http://127.0.0.1:9444');
        expect(record.process.pid).toBe(7788);
        expect(fake.spawned[0]?.args).toContain('--remote-debugging-port=9444');
        expect(launcher.terminate(record).terminated).toBe(true);
        expect(launcher.terminate(record).terminated).toBe(false);
    });

    it('never gives an acceptance launch a debugging endpoint', () => {
        const fake = fakeSpawner(1234);
        const launcher = createWindowsAppLauncher({
            clock: {
                now: () => 0,
                nowIso: () => '2026-09-04T12:00:00.000Z',
                sleep: () => Promise.resolve(),
            },
            spawner: fake.spawner,
            registry: createOwnedProcessRegistry(),
            executable: {
                executablePath: 'C:\\Users\\tester\\App\\EVB Viewer.exe',
                sha256: 'f'.repeat(64),
                architecture: 'arm64',
            },
        });
        const record = launcher.launch({
            profile: 'acceptance',
            documentPath: 'C:\\evb-test\\work\\run\\inputs\\doc.pdf',
        });
        expect(record.browserUrl).toBeNull();
        expect(record.args).toEqual(['C:\\evb-test\\work\\run\\inputs\\doc.pdf']);
    });
});
