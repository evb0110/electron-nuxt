import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    mkdtemp,
    readFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createTemporaryDirectoryRegistry} from '@tests/helpers/createTemporaryDirectoryRegistry';
import {
    publishReleaseIdentityToGithub,
    resolveReleaseIdentityForEnvironment,
} from '@scripts/release/resolve-sentry-build-identity.mjs';

const temporaryDirectories = createTemporaryDirectoryRegistry();

afterEach(async () => {
    await temporaryDirectories.cleanup();
});

describe('Sentry build identity CLI boundary', () => {
    it('resolves an explicit desktop target and publishes exact GitHub outputs', async () => {
        const directory = temporaryDirectories.register(
            await mkdtemp(path.join(tmpdir(), 'evb-sentry-identity-')),
        );
        const githubEnvironment = path.join(directory, 'github-env');
        const githubOutput = path.join(directory, 'github-output');
        const environment = {
            EVB_SENTRY_ENVIRONMENT: 'test',
            EVB_RELEASE_TARGET_PLATFORM: 'mac',
            EVB_RELEASE_TARGET_ARCH: 'arm64',
            GITHUB_ENV: githubEnvironment,
            GITHUB_OUTPUT: githubOutput,
        };
        const identity = resolveReleaseIdentityForEnvironment({
            args: ['--target=desktop'],
            environment,
            version: '1.2.3+ci.7',
        });

        expect(identity).toEqual({
            target: 'desktop',
            release: 'evb-viewer-desktop@1.2.3+ci.7',
            dist: 'macos-arm64',
            environment: 'test',
        });
        expect(publishReleaseIdentityToGithub({
            identity,
            environment,
        })).toBe(identity);
        await expect(readFile(githubEnvironment, 'utf8')).resolves.toBe([
            'EVB_SENTRY_DIAGNOSTICS_BUILD=1',
            'EVB_ELECTRON_SOURCEMAP=1',
            'EVB_SENTRY_TARGET=desktop',
            'EVB_SENTRY_RELEASE=evb-viewer-desktop@1.2.3+ci.7',
            'EVB_SENTRY_DIST=macos-arm64',
            'EVB_SENTRY_ENVIRONMENT=test',
            '',
        ].join('\n'));
        await expect(readFile(githubOutput, 'utf8')).resolves.toBe([
            'target=desktop',
            'release=evb-viewer-desktop@1.2.3+ci.7',
            'dist=macos-arm64',
            'environment=test',
            '',
        ].join('\n'));
    });

    it('rejects ambiguous and unsupported command-line targets', () => {
        expect(() => resolveReleaseIdentityForEnvironment({
            args: [
                '--target=desktop',
                '--target=web',
            ],
            environment: {},
            version: '1.2.3',
        })).toThrow(/at most one Sentry build target/iu);
        expect(() => resolveReleaseIdentityForEnvironment({
            args: ['--target=landing'],
            environment: {},
            version: '1.2.3',
        })).toThrow('Unsupported Sentry build target: landing');
        expect(() => publishReleaseIdentityToGithub()).toThrow('A resolved Sentry build identity is required');
    });
});
