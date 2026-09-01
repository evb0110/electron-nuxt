import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {
    describe,
    expect,
    it,
} from 'vitest';

interface IReleaseCheckCommand {
    args: string[];
    command: string;
}
interface IChecksModule {getLocalReleaseCheckCommands: (options?: {scanCleanupIdentity?: boolean}) => IReleaseCheckCommand[];}
interface IVerifyModule {runLocalReleaseVerify: (options: {
    argv: string[];
    env: Record<string, string>;
    receiptPath: string;
    runCommand: (command: string, args: string[], options: Record<string, unknown>) => string;
    snapshotGetter: () => {
        stagedDiff: string;
        trackedDiff: string;
        untrackedFiles: string[];
    };
}) => void;}

const checks = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/release/verify-local-checks.mjs'),
).href) as IChecksModule;
const verify = await import(pathToFileURL(
    path.resolve(process.cwd(), 'scripts/release/verify-local.mjs'),
).href) as IVerifyModule;

describe('local release gate rework', () => {
    it('keeps the default local check list to unique release checks', () => {
        expect(checks.getLocalReleaseCheckCommands().map(command => command.args[1])).toEqual([
            'check:drizzle-schema',
            'check:electron:install',
            'check:electron-builder:asar-unpack',
        ]);
    });

    it('adds the canonical scan-cleanup identity check only when requested', () => {
        expect(checks.getLocalReleaseCheckCommands({scanCleanupIdentity: true}).map(command => command.args[1])).toEqual([
            'check:drizzle-schema',
            'check:electron:install',
            'check:electron-builder:asar-unpack',
            'test:scan-cleanup:canonical-identity',
        ]);
    });

    it('passes the explicit scan-cleanup flag through the split verifier', () => {
        const calls: Array<{
            args: string[];
            command: string
        }> = [];
        verify.runLocalReleaseVerify({
            argv: ['--scan-cleanup-identity'],
            env: {},
            receiptPath: path.join('/tmp', `evb-release-rework-${process.pid}.json`),
            runCommand: (command, args) => {
                calls.push({
                    args,
                    command,
                });
                return '';
            },
            snapshotGetter: () => ({
                stagedDiff: '',
                trackedDiff: '',
                untrackedFiles: [],
            }),
        });

        expect(calls).toHaveLength(2);
        expect(calls[0]?.args).toEqual([
            'run',
            'release:verify:checks',
            '--scan-cleanup-identity',
        ]);
        expect(calls[1]?.args).toEqual([
            'run',
            'release:verify:package:local',
        ]);
    });
});
