import {
    describe,
    expect,
    it,
} from 'vitest';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const {
    detectHostReleasePlatform,
    expectsUpdaterMetadata,
    getLocalReleaseTargets,
    getReleaseAutomationEnv,
    getRequiredArtifactPatterns,
    shouldVerifyPackagedStartup,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/policy.mjs')).href);
const {
    getLocalReleaseCheckCommands,
    runLocalReleaseChecks,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local-checks.mjs')).href);
const {
    getLocalReleaseBuildCommand,
    getPackagingArgs,
} = await import(pathToFileURL(resolve(process.cwd(), 'scripts/release/verify-local-package.mjs')).href);

describe('release policy', () => {
    it('derives local release targets from host platform and arch', () => {
        expect(getLocalReleaseTargets({
            arch: 'arm64',
            platform: 'darwin',
        })).toEqual([{
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'mac',
        }]);

        expect(getLocalReleaseTargets({
            arch: 'x64',
            platform: 'win32',
        })).toEqual([{
            arch: 'x64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'win',
        }]);
    });

    it('keeps updater metadata and startup verification aligned with signing state', () => {
        const macTarget = {
            arch: 'arm64',
            expectsUpdaterMetadata: true,
            isPrimaryHostTarget: true,
            platform: 'mac',
        };
        const unsignedEnv = {};
        const signedEnv = {
            CSC_KEY_PASSWORD: 'secret',
            CSC_LINK: 'base64://cert',
        };

        expect(expectsUpdaterMetadata(macTarget, unsignedEnv)).toBe(false);
        expect(expectsUpdaterMetadata(macTarget, signedEnv)).toBe(true);
        expect(shouldVerifyPackagedStartup(macTarget, unsignedEnv)).toBe(false);
        expect(shouldVerifyPackagedStartup(macTarget, signedEnv)).toBe(true);
    });

    it('provides a release automation env that stays in CI mode', () => {
        expect(getReleaseAutomationEnv({ FOO: 'bar' })).toEqual({
            CI: 'true',
            EVB_AUTOMATION_HIDE_WINDOW: '1',
            EVB_AUTOMATION_NO_FOCUS: '1',
            FOO: 'bar',
        });
    });

    it('reports supported host platforms and required packaged artifacts', () => {
        expect(detectHostReleasePlatform('darwin')).toBe('mac');
        expect(detectHostReleasePlatform('linux')).toBe('linux');
        expect(detectHostReleasePlatform('win32')).toBe('win');
        expect(() => detectHostReleasePlatform('freebsd')).toThrow(
            'Unsupported local release platform "freebsd"',
        );

        expect(getRequiredArtifactPatterns({
            arch: 'arm64',
            platform: 'mac',
        }).map((pattern: RegExp) => pattern.source)).toEqual([
            '\\.dmg$',
            '\\.zip$',
        ]);
    });

    it('keeps release checks focused on static checks and release-critical tests', () => {
        const commands = getLocalReleaseCheckCommands()
            .map((command: { args: string[] }) => command.args.join(' '));

        expect(commands).toEqual([
            'run lint',
            'run typecheck',
            'run check:electron:install',
            'run test:release',
        ]);
        expect(commands.join('\n')).not.toContain('validate');
        expect(commands.join('\n')).not.toContain('build:strict');
        expect(commands.join('\n')).not.toContain('knip');
        expect(commands.join('\n')).not.toContain('typecheck:coverage');
        expect(commands.join('\n')).not.toContain('check:architecture');
    });

    it('runs release checks under the supplied CI-mode environment', () => {
        const calls: Array<{
            args: string[];
            command: string;
            env?: Record<string, string>;
        }> = [];

        runLocalReleaseChecks({
            env: {
                CI: 'true',
                FOO: 'bar',
            },
            runCommand: (command: string, args: string[], options: { env?: Record<string, string> }) => {
                calls.push({
                    args,
                    command,
                    env: options.env,
                });
            },
        });

        expect(calls).toHaveLength(4);
        expect(calls.every(call => call.command === 'pnpm')).toBe(true);
        expect(calls.every(call => call.env?.CI === 'true')).toBe(true);
        expect(calls.every(call => call.env?.FOO === 'bar')).toBe(true);
    });

    it('keeps build-warning enforcement in the local packaging phase', () => {
        expect(getLocalReleaseBuildCommand()).toEqual({
            args: [
                'run',
                'build:strict',
            ],
            command: 'pnpm',
        });
    });

    it('uses a ZIP-only local package check for supplemental macOS Intel builds', () => {
        expect(getPackagingArgs({
            arch: 'x64',
            platform: 'mac',
        })).toEqual([
            'exec',
            'electron-builder',
            '--publish',
            'never',
            '--mac',
            'zip',
            '--x64',
        ]);
    });
});
