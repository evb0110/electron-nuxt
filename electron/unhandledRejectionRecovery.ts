import { getErrorMessage } from '@electron/utils/error';

export type TMainSubsystem = 'agent' | 'djvu' | 'documents' | 'ocr' | 'search' | 'unknown';

interface IUnhandledRejectionRecoveryOptions {
    threshold?: number;
    windowMs?: number;
    now?: () => number;
    recover(subsystem: TMainSubsystem, reason: unknown): Promise<void> | void;
}

const SUBSYSTEM_PATTERNS: Array<[TMainSubsystem, RegExp]> = [
    [
        'ocr',
        /(?:electron[\\/](?:features[\\/])?ocr|ocr job|tesseract)/iu,
    ],
    [
        'search',
        /(?:electron[\\/](?:features[\\/])?search|search worker)/iu,
    ],
    [
        'djvu',
        /(?:electron[\\/](?:features[\\/])?djvu|ddjvu|djvm)/iu,
    ],
    [
        'agent',
        /(?:electron[\\/]features[\\/]agent|assistant|mcp server)/iu,
    ],
    [
        'documents',
        /(?:electron[\\/]features[\\/]documents|working copy|pdf mutation)/iu,
    ],
];

export function classifyUnhandledRejectionSubsystem(reason: unknown): TMainSubsystem {
    const details = reason instanceof Error
        ? `${reason.message}\n${reason.stack ?? ''}`
        : getErrorMessage(reason);
    return SUBSYSTEM_PATTERNS.find(([
        , pattern,
    ]) => pattern.test(details))?.[0] ?? 'unknown';
}

export function createUnhandledRejectionRecovery(options: IUnhandledRejectionRecoveryOptions) {
    const threshold = Math.max(2, options.threshold ?? 3);
    const windowMs = Math.max(1_000, options.windowMs ?? 60_000);
    const now = options.now ?? Date.now;
    const failures = new Map<TMainSubsystem, number[]>();
    const recovering = new Set<TMainSubsystem>();

    return async (reason: unknown) => {
        const subsystem = classifyUnhandledRejectionSubsystem(reason);
        if (subsystem === 'unknown') {
            return {
                subsystem,
                recovered: false,
                count: 1,
            };
        }
        const cutoff = now() - windowMs;
        const recent = (failures.get(subsystem) ?? []).filter(timestamp => timestamp >= cutoff);
        recent.push(now());
        failures.set(subsystem, recent);
        if (recent.length < threshold || recovering.has(subsystem)) {
            return {
                subsystem,
                recovered: false,
                count: recent.length,
            };
        }

        failures.delete(subsystem);
        recovering.add(subsystem);
        try {
            await options.recover(subsystem, reason);
            return {
                subsystem,
                recovered: true,
                count: recent.length,
            };
        } finally {
            recovering.delete(subsystem);
        }
    };
}
