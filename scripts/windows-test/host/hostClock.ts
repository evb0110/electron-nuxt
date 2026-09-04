import { setTimeout as delay } from 'node:timers/promises';

export interface IWindowsTestClock {
    nowIso(): string;
    monotonicMs(): number;
    sleep(milliseconds: number): Promise<void>;
}

export interface IWindowsTestManualClock extends IWindowsTestClock {advance(milliseconds: number): void;}

export function createSystemClock(): IWindowsTestClock {
    return {
        nowIso: () => new Date().toISOString(),
        monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
        sleep: async (milliseconds) => {
            await delay(milliseconds);
        },
    };
}

// Every deadline in the coordinator is measured with the monotonic reading, so
// a deterministic clock can drive the whole state machine without real waits.
export function createManualClock(startWallClockMs = Date.UTC(2026, 8, 4, 12, 0, 0)): IWindowsTestManualClock {
    let wallClockMs = startWallClockMs;
    let monotonic = 0;
    const advance = (milliseconds: number) => {
        wallClockMs += milliseconds;
        monotonic += milliseconds;
    };
    return {
        nowIso: () => new Date(wallClockMs).toISOString(),
        monotonicMs: () => monotonic,
        sleep: (milliseconds) => {
            advance(milliseconds);
            return Promise.resolve();
        },
        advance,
    };
}
