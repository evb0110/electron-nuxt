import path from 'node:path';
import type { ICommandRunner } from '@scripts/windows-test/host/utmctlClient';
import { isVmUuid } from '@scripts/windows-test/contracts/windowsTestContracts';

export const UTM_BUNDLE_EXTENSION = '.utm';

export const UTM_BUNDLE_CONFIG_FILE = 'config.plist';

export function utmBundlePathForName(testImageRoot: string, vmName: string) {
    return path.join(testImageRoot, `${vmName}${UTM_BUNDLE_EXTENSION}`);
}

export interface IVmBundleIdentityReader {readVmId(bundlePath: string): Promise<string | null>;}

// `utmctl` never prints a bundle path, so the coordinator reads the UUID out of
// the bundle it located by name and cross-checks it against the UUID observed
// in the registration diff before any destructive call.
export function createPlutilBundleIdentityReader(
    runner: ICommandRunner,
    options: {
        plutilPath?: string;
        timeoutMs?: number;
    } = {},
): IVmBundleIdentityReader {
    const plutilPath = options.plutilPath ?? '/usr/bin/plutil';
    const timeoutMs = options.timeoutMs ?? 10_000;
    return {readVmId: async (bundlePath) => {
        const result = await runner.run(plutilPath, [
            '-extract',
            'Information.UUID',
            'raw',
            '-o',
            '-',
            path.join(bundlePath, UTM_BUNDLE_CONFIG_FILE),
        ], {timeoutMs});
        if (result.exitCode !== 0) {
            return null;
        }
        const uuid = result.stdout.trim().toLowerCase();
        return isVmUuid(uuid) ? uuid : null;
    }};
}
