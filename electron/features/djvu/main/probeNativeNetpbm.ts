import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';

interface INativeNetpbmProbe {
    magic: 'P4' | 'P5' | 'P6';
    width: number;
    height: number;
    dataOffset: number;
    nonWhiteRatio: number;
    darkRatio: number;
    colorRatio: number;
    maxDarkRunRatio: number;
    minChannel: number;
    maxChannel: number;
    blackRatio: number;
    maxBlackRunRatio: number;
    dominantColor: [number, number, number];
}

function parseNativeNetpbmProbe(value: unknown): INativeNetpbmProbe {
    if (!value || typeof value !== 'object') {
        throw new Error('Native Netpbm probe returned an invalid payload');
    }
    const probe = value as Record<string, unknown>;
    const numericFields = [
        'width',
        'height',
        'dataOffset',
        'nonWhiteRatio',
        'darkRatio',
        'colorRatio',
        'maxDarkRunRatio',
        'minChannel',
        'maxChannel',
        'blackRatio',
        'maxBlackRunRatio',
    ] as const;
    if ((probe.magic !== 'P4' && probe.magic !== 'P5' && probe.magic !== 'P6')
        || numericFields.some(field => typeof probe[field] !== 'number' || !Number.isFinite(probe[field]))) {
        throw new Error('Native Netpbm probe returned invalid metrics');
    }
    if (!Array.isArray(probe.dominantColor)
        || probe.dominantColor.length !== 3
        || probe.dominantColor.some(channel => typeof channel !== 'number' || !Number.isInteger(channel))) {
        throw new Error('Native Netpbm probe returned an invalid dominant color');
    }
    return {
        blackRatio: probe.blackRatio as number,
        colorRatio: probe.colorRatio as number,
        darkRatio: probe.darkRatio as number,
        dataOffset: probe.dataOffset as number,
        dominantColor: probe.dominantColor as [number, number, number],
        height: probe.height as number,
        magic: probe.magic,
        maxBlackRunRatio: probe.maxBlackRunRatio as number,
        maxChannel: probe.maxChannel as number,
        maxDarkRunRatio: probe.maxDarkRunRatio as number,
        minChannel: probe.minChannel as number,
        nonWhiteRatio: probe.nonWhiteRatio as number,
        width: probe.width as number,
    };
}

export async function probeNativeNetpbm(binaryPath: string | null, path: string) {
    if (!binaryPath) {
        return null;
    }
    try {
        const result = await runNativeToolCommand(binaryPath, [
            '--probe-netpbm',
            path,
        ], {
            commandLabel: 'evb-pdf-image-combine(probe-netpbm)',
            maxStdoutBytes: 64 * 1024,
            rejectOnStdoutTruncation: true,
            timeoutMs: 60_000,
        });
        return parseNativeNetpbmProbe(JSON.parse(result.stdout ?? ''));
    } catch (error) {
        if (process.env.VITEST === 'true') {
            return null;
        }
        throw error;
    }
}
