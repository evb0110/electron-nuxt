import {
    mkdtemp,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    WindowsTestConfigError,
    describeMissingWindowsTestConfig,
    loadWindowsTestHostConfig,
    parseWindowsTestHostConfig,
} from '@scripts/windows-test/host/hostConfig';

const ALLOWED_VM_ID = '11111111-2222-4333-8444-555555555555';
const GOLDEN_VM_ID = '22222222-3333-4444-8555-666666666666';
const PERSONAL_VM_ID = '99999999-8888-4777-8666-555555555555';
const CONFIG_FILE = '/tmp/windows-tests/config.json';

function validConfig(overrides: Record<string, unknown> = {}) {
    return {
        schemaVersion: 1,
        testImageRoot: '/Volumes/WindowsTests/images',
        allowedTestVmIds: [ALLOWED_VM_ID],
        goldenImageId: 'win11-arm64-2026-09',
        goldenVmId: GOLDEN_VM_ID,
        personalVmIdsDenied: [PERSONAL_VM_ID],
        candidate: {
            artifactPath: '/Volumes/WindowsTests/artifacts/EVBViewer-Setup.exe',
            sha256: 'a'.repeat(64),
            fileName: 'EVBViewer-Setup.exe',
            version: '3.4.5',
            sourceSha: 'b'.repeat(40),
            appArch: 'arm64',
        },
        environment: 'win11-arm64',
        qualifiedLaunchers: ['/Applications/Utilities/Terminal.app'],
        retention: {
            passDays: 7,
            failureDays: 30,
            maxFailedClones: 1,
            minFreeBytes: 64_000_000_000,
        },
        ...overrides,
    };
}

describe('windows test host configuration', () => {
    it('can register an unqualified host without claiming launcher consent', () => {
        expect(parseWindowsTestHostConfig(validConfig({qualifiedLaunchers: []}), CONFIG_FILE).qualifiedLaunchers).toEqual([]);
    });
    it('accepts a complete configuration and normalizes UUID case', () => {
        const config = parseWindowsTestHostConfig(
            validConfig({
                allowedTestVmIds: [ALLOWED_VM_ID.toUpperCase()],
                goldenVmId: GOLDEN_VM_ID.toUpperCase(),
            }),
            CONFIG_FILE,
        );

        expect(config.allowedTestVmIds).toEqual([ALLOWED_VM_ID]);
        expect(config.goldenVmId).toBe(GOLDEN_VM_ID);
        expect(config.candidate?.version).toBe('3.4.5');
        expect(config.retention.maxFailedClones).toBe(1);
    });

    it('names the missing field in the error message', () => {
        const withoutEnvironment = validConfig();
        delete (withoutEnvironment as Record<string, unknown>).environment;

        expect(() => parseWindowsTestHostConfig(withoutEnvironment, CONFIG_FILE))
            .toThrow(/field "environment" must be a non-empty string/u);
    });

    it('reports nested candidate and retention fields with their prefix', () => {
        expect(() => parseWindowsTestHostConfig(
            validConfig({candidate: {
                ...validConfig().candidate,
                sha256: 'not-a-digest',
            }}),
            CONFIG_FILE,
        )).toThrow(/field "candidate\.sha256"/u);

        expect(() => parseWindowsTestHostConfig(
            validConfig({retention: {
                ...validConfig().retention,
                minFreeBytes: -1,
            }}),
            CONFIG_FILE,
        )).toThrow(/field "retention\.minFreeBytes" must be a non-negative integer/u);
    });

    it('allows a fresh host with no disposable clones yet', () => {
        expect(parseWindowsTestHostConfig(validConfig({allowedTestVmIds: []}), CONFIG_FILE).allowedTestVmIds).toEqual([]);
    });

    it('refuses a golden image in the destructive allowlist', () => {
        expect(() => parseWindowsTestHostConfig(validConfig({allowedTestVmIds: [GOLDEN_VM_ID]}), CONFIG_FILE))
            .toThrow(/must not include the golden image/u);
    });

    it('refuses non-UUID entries and relative paths', () => {
        expect(() => parseWindowsTestHostConfig(validConfig({allowedTestVmIds: ['Windows 11 Test']}), CONFIG_FILE))
            .toThrow(/are not VM UUIDs/u);
        expect(() => parseWindowsTestHostConfig(validConfig({testImageRoot: 'images'}), CONFIG_FILE))
            .toThrow(/field "testImageRoot" must be an absolute path/u);
    });

    it('refuses a golden image that is also denied', () => {
        expect(() => parseWindowsTestHostConfig(
            validConfig({personalVmIdsDenied: [GOLDEN_VM_ID]}),
            CONFIG_FILE,
        )).toThrow(/must not also appear in personalVmIdsDenied/u);
    });

    it('refuses an allowlisted test VM that is also denied as personal', () => {
        expect(() => parseWindowsTestHostConfig(
            validConfig({personalVmIdsDenied: [ALLOWED_VM_ID]}),
            CONFIG_FILE,
        )).toThrow(/must not list denied personal VM UUIDs/u);
    });

    it('treats an absent candidate as unstaged rather than invalid', () => {
        expect(parseWindowsTestHostConfig(validConfig({candidate: null}), CONFIG_FILE).candidate).toBeNull();
    });
});

describe('loading the windows test host configuration', () => {
    let dataRoot = '';

    beforeEach(async () => {
        dataRoot = await mkdtemp(path.join(tmpdir(), 'evb-windows-config-'));
    });

    afterEach(async () => {
        await rm(dataRoot, {
            force: true,
            recursive: true,
        });
    });

    it('reports a missing file as a setup error naming the path and --artifact', async () => {
        const configFile = path.join(dataRoot, 'config.json');
        const error = await loadWindowsTestHostConfig(configFile).catch((thrown: unknown) => thrown);

        expect(error).toBeInstanceOf(WindowsTestConfigError);
        expect((error as WindowsTestConfigError).kind).toBe('config-missing');
        expect((error as WindowsTestConfigError).message).toBe(describeMissingWindowsTestConfig(configFile));
        expect((error as WindowsTestConfigError).message).toContain(configFile);
        expect((error as WindowsTestConfigError).message).toContain('--artifact');
    });

    it('reports malformed JSON separately from invalid content', async () => {
        const configFile = path.join(dataRoot, 'config.json');
        await writeFile(configFile, '{ not json', 'utf8');

        const error = await loadWindowsTestHostConfig(configFile).catch((thrown: unknown) => thrown);

        expect((error as WindowsTestConfigError).kind).toBe('config-malformed');
    });

    it('loads a valid configuration file', async () => {
        const configFile = path.join(dataRoot, 'config.json');
        await writeFile(configFile, JSON.stringify(validConfig()), 'utf8');

        await expect(loadWindowsTestHostConfig(configFile)).resolves.toMatchObject({environment: 'win11-arm64'});
    });
});
