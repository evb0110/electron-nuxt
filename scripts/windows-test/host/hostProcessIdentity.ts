import { isProcessAlive } from '@scripts/electron-run/electronRunProcessTree';
import type { ICommandRunner } from '@scripts/windows-test/host/utmctlClient';

export interface IHostProcessIdentityProbe {
    isAlive(pid: number): boolean;
    startTime(pid: number): Promise<string | null>;
}

// A PID alone cannot establish ownership across PID reuse or a host reboot, so
// every lease decision pairs it with the process start time.
export function createProcessIdentityProbe(
    runner: ICommandRunner,
    options: {
        psPath?: string;
        timeoutMs?: number;
    } = {},
): IHostProcessIdentityProbe {
    const psPath = options.psPath ?? '/bin/ps';
    const timeoutMs = options.timeoutMs ?? 5_000;
    return {
        isAlive: pid => isProcessAlive(pid),
        startTime: async (pid) => {
            if (!Number.isInteger(pid) || pid <= 0) {
                return null;
            }
            const result = await runner.run(psPath, [
                '-o',
                'lstart=',
                '-p',
                String(pid),
            ], {timeoutMs});
            if (result.exitCode !== 0) {
                return null;
            }
            const startTime = result.stdout.trim();
            return startTime.length > 0 ? startTime : null;
        },
    };
}

export function ownershipMatches(
    probe: {
        alive: boolean;
        observedStartTime: string | null;
    },
    recordedStartTime: string,
) {
    // A failed ps probe on a live pid is unknown ownership, and an unknown
    // owner is treated as the owner so no live run loses its lock or lease.
    return probe.alive
        && (probe.observedStartTime === null || probe.observedStartTime === recordedStartTime);
}
