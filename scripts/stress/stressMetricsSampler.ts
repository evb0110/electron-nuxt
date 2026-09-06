import { getErrorMessage } from '@contracts/getErrorMessage';
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { promisify } from 'node:util';
import type { Page } from 'puppeteer-core';
import { collectDescendantPidsUnix } from '@scripts/electron-run/electronRunProcessTree';
import { runWithElectronE2EDeadline } from '@tests/e2e/electron/helpers/electronE2ESessionFailure';
import { percentile } from '@scripts/stress/percentile';
import type {
    IStressMetricSample,
    IStressMetricsSummary,
    IStressProbeTotals,
} from '@scripts/stress/stressTypes';

const PROBE_KEY = '__evbStressProbe';
const FRAME_BUDGET_MS = 1000 / 60;
const MAX_ERROR_MESSAGES = 50;
/** A hung renderer must not keep `stop()` waiting on an in-flight `page.evaluate`. */
const STOP_DRAIN_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

export interface IStressMetricsSampler {
    sample: () => Promise<IStressMetricSample>;
    counters: () => {
        consoleErrorCount: number;
        pageErrorCount: number;
        rendererCrashed: boolean;
    };
    lastSample: () => IStressMetricSample | null;
    stop: () => Promise<IStressMetricsSummary>;
}

export interface IStressMetricsSamplerOptions {
    page: Page;
    electronPid: number | null;
    outputPath: string;
    coarseIntervalMs?: number;
    consoleErrorAllowlist?: RegExp[];
    log?: (line: string) => void;
}

/**
 * Process-tree RSS via `ps`. `page.metrics()` only sees the renderer heap;
 * the GPU process, utility processes and the main process are where OOM
 * kills actually happen on a small machine.
 */
export async function readProcessTreeRss(rootPid: number | null) {
    const rssByPid: Record<string, number> = {};
    if (rootPid === null || process.platform === 'win32') {
        return rssByPid;
    }
    const pids = [
        rootPid,
        ...collectDescendantPidsUnix(rootPid),
    ];
    try {
        const {stdout} = await execFileAsync('ps', [
            '-o',
            'pid=,rss=',
            '-p',
            pids.join(','),
        ], {encoding: 'utf8'});
        for (const line of stdout.split('\n')) {
            const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(line);
            if (match) {
                rssByPid[match[1] ?? ''] = Number(match[2]) * 1024;
            }
        }
    } catch {
        // `ps` failed or every pid exited between the tree walk and the call.
    }
    return rssByPid;
}

interface IProbeWindow extends Window {[PROBE_KEY]?: {
    drain: () => IStressProbeTotals;
    teardown: () => void;
} | undefined;}

/**
 * Three clocks (timer, MessageChannel, Worker) plus PerformanceObserver
 * longtask and a rAF gap sampler. A timer alone can be throttled by the
 * browser, so a gap on every clock is the only trustworthy "main thread was
 * busy" signal. The probe accumulates in-page and is drained by the sampler.
 */
async function installProbe(page: Page) {
    await page.evaluate((key: string) => {
        const existing = (window as IProbeWindow)[key as typeof PROBE_KEY];
        if (existing) {
            return;
        }
        let timerMaxGapMs = 0;
        let channelMaxGapMs = 0;
        let workerMaxGapMs: number | null = 0;
        let longTaskCount = 0;
        let longTaskMaxMs: number | null = 0;
        let longTaskTotalMs = 0;
        let longTaskDurationsMs: number[] = [];
        let frameCount = 0;
        let frameMaxGapMs = 0;
        let frameGapsMs: number[] = [];
        let torndown = false;

        let timerLast = performance.now();
        const timer = setInterval(() => {
            const now = performance.now();
            timerMaxGapMs = Math.max(timerMaxGapMs, now - timerLast);
            timerLast = now;
        }, 50);

        const channel = new MessageChannel();
        let channelLast = performance.now();
        channel.port1.onmessage = () => {
            if (torndown) {
                return;
            }
            const now = performance.now();
            channelMaxGapMs = Math.max(channelMaxGapMs, now - channelLast);
            channelLast = now;
            setTimeout(() => channel.port2.postMessage(0), 50);
        };
        channel.port2.postMessage(0);

        let worker: Worker | null = null;
        try {
            const source = 'setInterval(() => self.postMessage(performance.now()), 50);';
            worker = new Worker(URL.createObjectURL(new Blob([source], {type: 'text/javascript'})));
            let workerLast = performance.now();
            worker.onmessage = () => {
                const now = performance.now();
                workerMaxGapMs = Math.max(workerMaxGapMs ?? 0, now - workerLast);
                workerLast = now;
            };
        } catch {
            workerMaxGapMs = null;
        }

        let observer: PerformanceObserver | null = null;
        try {
            observer = new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    longTaskCount += 1;
                    longTaskMaxMs = Math.max(longTaskMaxMs ?? 0, entry.duration);
                    longTaskTotalMs += entry.duration;
                    if (longTaskDurationsMs.length < 5000) {
                        longTaskDurationsMs.push(entry.duration);
                    }
                }
            });
            observer.observe({entryTypes: ['longtask']});
        } catch {
            observer = null;
            longTaskMaxMs = null;
        }

        let frameLast = performance.now();
        const onFrame = () => {
            if (torndown) {
                return;
            }
            const now = performance.now();
            const gap = now - frameLast;
            frameLast = now;
            frameCount += 1;
            frameMaxGapMs = Math.max(frameMaxGapMs, gap);
            if (frameGapsMs.length < 20000) {
                frameGapsMs.push(gap);
            }
            requestAnimationFrame(onFrame);
        };
        requestAnimationFrame(onFrame);

        (window as IProbeWindow)[key as typeof PROBE_KEY] = {
            drain: () => {
                const totals: IStressProbeTotals = {
                    timerMaxGapMs,
                    channelMaxGapMs,
                    workerMaxGapMs,
                    longTaskCount,
                    longTaskMaxMs,
                    longTaskTotalMs,
                    longTaskDurationsMs,
                    frameCount,
                    frameMaxGapMs,
                    frameGapsMs,
                };
                timerMaxGapMs = 0;
                channelMaxGapMs = 0;
                workerMaxGapMs = workerMaxGapMs === null ? null : 0;
                longTaskCount = 0;
                longTaskMaxMs = longTaskMaxMs === null ? null : 0;
                longTaskTotalMs = 0;
                longTaskDurationsMs = [];
                frameCount = 0;
                frameMaxGapMs = 0;
                frameGapsMs = [];
                frameLast = performance.now();
                timerLast = frameLast;
                channelLast = frameLast;
                return totals;
            },
            teardown: () => {
                torndown = true;
                clearInterval(timer);
                channel.port1.close();
                channel.port2.close();
                worker?.terminate();
                observer?.disconnect();
                (window as IProbeWindow)[key as typeof PROBE_KEY] = undefined;
            },
        };
    }, PROBE_KEY);
}

/** Best effort: a crashed or navigated page has already lost the probe. */
async function teardownProbe(page: Page) {
    try {
        await runWithElectronE2EDeadline('stress probe teardown', 5_000, () => page.evaluate((key: string) => {
            (window as IProbeWindow)[key as typeof PROBE_KEY]?.teardown();
        }, PROBE_KEY));
    } catch {
        // Nothing left to tear down.
    }
}

async function drainProbe(page: Page) {
    try {
        return await page.evaluate((key: string) => {
            const probe = (window as IProbeWindow)[key as typeof PROBE_KEY];
            return probe ? probe.drain() : null;
        }, PROBE_KEY);
    } catch {
        return null;
    }
}

export function summarizeStressMetricSamples(
    samples: readonly IStressMetricSample[],
    counters: {
        consoleErrors: string[];
        pageErrors: string[];
        rendererCrashed: boolean;
        crashReason: string | null;
    },
): IStressMetricsSummary {
    let peakRssBytes = 0;
    let peakRssPid: string | null = null;
    let peakJsHeapUsedBytes: number | null = null;
    let heartbeatMaxGapMs = 0;
    let workerHeartbeatMaxGapMs: number | null = null;
    let longTaskCount = 0;
    let longTaskMaxMs: number | null = null;
    let frameGapMaxMs = 0;
    let frameCount = 0;
    let droppedFrames = 0;
    const longTaskDurations: number[] = [];
    const frameGaps: number[] = [];
    const heapSamples = samples.map(sample => sample.jsHeapUsedBytes).filter((value): value is number => value !== null);

    for (const sample of samples) {
        if (sample.rssBytesTotal > peakRssBytes) {
            peakRssBytes = sample.rssBytesTotal;
            const [pid] = Object.entries(sample.rssBytesByPid).sort((left, right) => right[1] - left[1])[0] ?? [null];
            peakRssPid = pid;
        }
        if (sample.jsHeapUsedBytes !== null) {
            peakJsHeapUsedBytes = Math.max(peakJsHeapUsedBytes ?? 0, sample.jsHeapUsedBytes);
        }
        const probe = sample.probe;
        if (!probe) {
            continue;
        }
        heartbeatMaxGapMs = Math.max(heartbeatMaxGapMs, Math.min(probe.timerMaxGapMs, probe.channelMaxGapMs));
        if (probe.workerMaxGapMs !== null) {
            workerHeartbeatMaxGapMs = Math.max(workerHeartbeatMaxGapMs ?? 0, probe.workerMaxGapMs);
        }
        longTaskCount += probe.longTaskCount;
        if (probe.longTaskMaxMs !== null) {
            longTaskMaxMs = Math.max(longTaskMaxMs ?? 0, probe.longTaskMaxMs);
        }
        longTaskDurations.push(...probe.longTaskDurationsMs);
        frameGapMaxMs = Math.max(frameGapMaxMs, probe.frameMaxGapMs);
        frameCount += probe.frameCount;
        frameGaps.push(...probe.frameGapsMs);
        droppedFrames += probe.frameGapsMs.filter(gap => gap > FRAME_BUDGET_MS * 2).length;
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    return {
        sampleCount: samples.length,
        durationMs: first && last ? last.tOffsetMs - first.tOffsetMs : 0,
        peakRssBytes,
        peakRssPid,
        peakJsHeapUsedBytes,
        firstJsHeapUsedBytes: heapSamples[0] ?? null,
        lastJsHeapUsedBytes: heapSamples[heapSamples.length - 1] ?? null,
        heartbeatMaxGapMs,
        workerHeartbeatMaxGapMs,
        longTaskCount,
        longTaskP95Ms: percentile(longTaskDurations, 95) ?? 0,
        longTaskMaxMs,
        frameGapP95Ms: percentile(frameGaps, 95) ?? 0,
        frameGapMaxMs,
        droppedFrameRatio: frameCount > 0 ? droppedFrames / frameCount : 0,
        consoleErrors: counters.consoleErrors,
        pageErrors: counters.pageErrors,
        rendererCrashed: counters.rendererCrashed,
        crashReason: counters.crashReason,
    };
}

export async function startStressMetricsSampler(options: IStressMetricsSamplerOptions): Promise<IStressMetricsSampler> {
    const {page} = options;
    const coarseIntervalMs = options.coarseIntervalMs ?? 250;
    const allowlist = options.consoleErrorAllowlist ?? [];
    const startedAt = Date.now();
    const samples: IStressMetricSample[] = [];
    const consoleErrors: string[] = [];
    let consoleErrorCount = 0;
    let pageErrorCount = 0;
    const pageErrors: string[] = [];
    let rendererCrashed = false;
    let crashReason: string | null = null;
    let stream: WriteStream | null = createWriteStream(options.outputPath, {flags: 'a'});
    let sampling = false;
    let stopped = false;

    const onConsole = (message: {
        type: () => string;
        text: () => string
    }) => {
        if (message.type() !== 'error') {
            return;
        }
        const text = message.text();
        if (allowlist.some(pattern => pattern.test(text))) {
            return;
        }
        consoleErrorCount += 1;
        if (consoleErrors.length < MAX_ERROR_MESSAGES) {
            consoleErrors.push(text);
        }
    };
    const onPageError = (error: unknown) => {
        pageErrorCount += 1;
        if (pageErrors.length < MAX_ERROR_MESSAGES) {
            pageErrors.push(getErrorMessage(error));
        }
    };
    const onCrash = (error: unknown) => {
        rendererCrashed = true;
        crashReason = getErrorMessage(error);
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('error', onCrash);

    await installProbe(page);

    const takeSample = async () => {
        const rssBytesByPid = await readProcessTreeRss(options.electronPid);
        let jsHeapUsedBytes: number | null = null;
        let jsHeapTotalBytes: number | null = null;
        try {
            const metrics = await page.metrics();
            jsHeapUsedBytes = metrics.JSHeapUsedSize ?? null;
            jsHeapTotalBytes = metrics.JSHeapTotalSize ?? null;
        } catch {
            jsHeapUsedBytes = null;
        }
        const probe = await drainProbe(page);
        if (probe === null && !rendererCrashed) {
            try {
                await installProbe(page);
            } catch {
                // Navigation or crash in flight; the next tick retries.
            }
        }
        const sample: IStressMetricSample = {
            tOffsetMs: Date.now() - startedAt,
            epochMs: Date.now(),
            rssBytesTotal: Object.values(rssBytesByPid).reduce((sum, value) => sum + value, 0),
            rssBytesByPid,
            jsHeapUsedBytes,
            jsHeapTotalBytes,
            probe,
            consoleErrorCount,
            pageErrorCount,
        };
        samples.push(sample);
        stream?.write(`${JSON.stringify(sample)}\n`);
        return sample;
    };

    const tick = async () => {
        if (sampling || stopped) {
            return;
        }
        sampling = true;
        try {
            await takeSample();
        } catch {
            // A sample lost during a renderer swap is not a finding.
        } finally {
            sampling = false;
        }
    };
    const timer = setInterval(() => {
        void tick();
    }, coarseIntervalMs);

    return {
        sample: takeSample,
        counters: () => ({
            consoleErrorCount,
            pageErrorCount,
            rendererCrashed,
        }),
        lastSample: () => samples[samples.length - 1] ?? null,
        stop: async () => {
            stopped = true;
            clearInterval(timer);
            const drainDeadline = Date.now() + STOP_DRAIN_TIMEOUT_MS;
            while (sampling && Date.now() < drainDeadline) {
                await new Promise(resolve => setTimeout(resolve, 20));
            }
            if (sampling) {
                options.log?.(`metrics sampler: in-flight sample still pending after ${STOP_DRAIN_TIMEOUT_MS}ms; detaching anyway`);
            }
            page.off('console', onConsole);
            page.off('pageerror', onPageError);
            page.off('error', onCrash);
            await teardownProbe(page);
            await new Promise<void>((resolve) => {
                stream?.end(() => resolve());
                stream = null;
            });
            return summarizeStressMetricSamples(samples, {
                consoleErrors,
                pageErrors,
                rendererCrashed,
                crashReason,
            });
        },
    };
}
