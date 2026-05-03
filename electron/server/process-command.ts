import { runElectronCommand } from '@electron/utils/exec';

export function normalizeProcessCommandLine(value: string) {
    return value.replaceAll('\0', ' ').trim();
}

export async function readProcessCommandLine(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) {
        return null;
    }

    try {
        if (process.platform === 'win32') {
            const result = await runElectronCommand('powershell', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `try { (Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine } catch { "" }`,
            ], {
                timeoutMs: 3_000,
                maxStdoutBytes: 32 * 1024,
                maxStderrBytes: 8 * 1024,
            });
            return normalizeProcessCommandLine(result.stdout);
        }

        const result = await runElectronCommand('ps', [
            '-p',
            String(pid),
            '-o',
            'command=',
        ], {
            timeoutMs: 3_000,
            maxStdoutBytes: 32 * 1024,
            maxStderrBytes: 8 * 1024,
        });
        return normalizeProcessCommandLine(result.stdout);
    } catch {
        return null;
    }
}
