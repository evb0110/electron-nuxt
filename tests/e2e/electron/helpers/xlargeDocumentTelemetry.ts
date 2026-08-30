import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Page} from 'puppeteer-core';

const execFileAsync = promisify(execFile);

export interface IRendererRssSample {
    atMs: number;
    electronBytes: number | null;
    rendererBytes: number | null;
    rendererJsHeapUsedBytes: number | null;
    rendererJsHeapTotalBytes: number | null;
    runnerBytes: number;
}

export interface IRendererRssTelemetry {
    electronPid: number | null;
    baselineElectronBytes: number | null;
    peakElectronBytes: number | null;
    lastElectronBytes: number | null;
    baselineRendererBytes: number | null;
    peakRendererBytes: number | null;
    lastRendererBytes: number | null;
    rendererRssDeltaBytes: number | null;
    baselineRunnerBytes: number | null;
    peakRunnerBytes: number | null;
    lastRunnerBytes: number | null;
    baselineRendererJsHeapUsedBytes: number | null;
    peakRendererJsHeapUsedBytes: number | null;
    lastRendererJsHeapUsedBytes: number | null;
    rendererJsHeapDeltaBytes: number | null;
    samples: IRendererRssSample[];
}

export interface IRssSampler {stop: () => Promise<IRendererRssTelemetry>;}

interface IRendererJsHeapSample {
    usedBytes: number | null;
    totalBytes: number | null;
}

async function readElectronProcessMemory(pid: number | null) {
    if (!pid || process.platform === 'win32') {
        return {
            electronBytes: null,
            rendererBytes: null,
        };
    }
    try {
        const {stdout} = await execFileAsync('ps', [
            '-eo',
            'pid=,ppid=,rss=,args=',
        ], {encoding: 'utf8'});
        const processes = stdout.trim().split('\n').flatMap((line) => {
            const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u);
            if (!match) {
                return [];
            }
            return [{
                args: match[4] ?? '',
                pid: Number(match[1]),
                ppid: Number(match[2]),
                rssBytes: Number(match[3]) * 1_024,
            }];
        });
        const descendants = new Set([pid]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const processInfo of processes) {
                if (!descendants.has(processInfo.pid) && descendants.has(processInfo.ppid)) {
                    descendants.add(processInfo.pid);
                    changed = true;
                }
            }
        }
        const electron = processes.find(processInfo => processInfo.pid === pid);
        const rendererProcesses = processes.filter(processInfo => (
            descendants.has(processInfo.pid)
            && processInfo.args.includes('--type=renderer')
        ));
        return {
            electronBytes: electron && Number.isFinite(electron.rssBytes) ? electron.rssBytes : null,
            rendererBytes: rendererProcesses.length > 0
                ? rendererProcesses.reduce((total, processInfo) => total + processInfo.rssBytes, 0)
                : null,
        };
    } catch {
        return {
            electronBytes: null,
            rendererBytes: null,
        };
    }
}

async function readRendererJsHeap(page: Page): Promise<IRendererJsHeapSample> {
    try {
        const metrics = await page.metrics();
        const usedBytes = typeof metrics.JSHeapUsedSize === 'number'
            && Number.isFinite(metrics.JSHeapUsedSize)
            ? metrics.JSHeapUsedSize
            : null;
        const totalBytes = typeof metrics.JSHeapTotalSize === 'number'
            && Number.isFinite(metrics.JSHeapTotalSize)
            ? metrics.JSHeapTotalSize
            : null;
        if (usedBytes !== null || totalBytes !== null) {
            return {
                totalBytes,
                usedBytes,
            };
        }
    } catch {
        // Fall through to performance.memory for browsers without CDP metrics.
    }

    try {
        return await page.evaluate(() => {
            const memory = (performance as Performance & {memory?: {
                totalJSHeapSize?: unknown;
                usedJSHeapSize?: unknown;
            };}).memory;
            const usedBytes = typeof memory?.usedJSHeapSize === 'number'
                && Number.isFinite(memory.usedJSHeapSize)
                ? memory.usedJSHeapSize
                : null;
            const totalBytes = typeof memory?.totalJSHeapSize === 'number'
                && Number.isFinite(memory.totalJSHeapSize)
                ? memory.totalJSHeapSize
                : null;
            return {
                totalBytes,
                usedBytes,
            };
        });
    } catch {
        return {
            totalBytes: null,
            usedBytes: null,
        };
    }
}

export function createXlargeDocumentRssSampler(
    page: Page,
    electronPid: number | null,
    sampleIntervalMs = 250,
): IRssSampler {
    const startedAt = performance.now();
    const samples: IRendererRssSample[] = [];
    let running = true;
    let result: IRendererRssTelemetry | null = null;

    const sample = async () => {
        const [
            processMemory,
            rendererJsHeap,
        ] = await Promise.all([
            readElectronProcessMemory(electronPid),
            readRendererJsHeap(page),
        ]);
        if (running) {
            samples.push({
                atMs: Math.round((performance.now() - startedAt) * 10) / 10,
                electronBytes: processMemory.electronBytes,
                rendererBytes: processMemory.rendererBytes,
                rendererJsHeapTotalBytes: rendererJsHeap.totalBytes,
                rendererJsHeapUsedBytes: rendererJsHeap.usedBytes,
                runnerBytes: process.memoryUsage().rss,
            });
        }
    };

    const loop = (async () => {
        while (running) {
            await sample();
            if (running) {
                await new Promise<void>(resolvePromise => {
                    setTimeout(resolvePromise, sampleIntervalMs);
                });
            }
        }
    })();

    return {stop: async () => {
        if (result) {
            return result;
        }
        running = false;
        await loop;
        const electronValues = samples
            .map(sampleValue => sampleValue.electronBytes)
            .filter((value): value is number => value !== null);
        const rendererJsHeapValues = samples
            .map(sampleValue => sampleValue.rendererJsHeapUsedBytes)
            .filter((value): value is number => value !== null);
        const runnerValues = samples.map(sampleValue => sampleValue.runnerBytes);
        const rendererValues = samples
            .map(sampleValue => sampleValue.rendererBytes)
            .filter((value): value is number => value !== null);
        const baselineRendererBytes = rendererValues[0] ?? null;
        const peakRendererBytes = rendererValues.length > 0 ? Math.max(...rendererValues) : null;
        const baselineRendererJsHeapUsedBytes = rendererJsHeapValues[0] ?? null;
        const peakRendererJsHeapUsedBytes = rendererJsHeapValues.length > 0
            ? Math.max(...rendererJsHeapValues)
            : null;
        result = {
            electronPid,
            baselineElectronBytes: electronValues[0] ?? null,
            peakElectronBytes: electronValues.length > 0 ? Math.max(...electronValues) : null,
            lastElectronBytes: electronValues.at(-1) ?? null,
            baselineRendererBytes,
            peakRendererBytes,
            lastRendererBytes: rendererValues.at(-1) ?? null,
            rendererRssDeltaBytes: baselineRendererBytes !== null && peakRendererBytes !== null
                ? Math.max(0, peakRendererBytes - baselineRendererBytes)
                : null,
            baselineRunnerBytes: runnerValues[0] ?? null,
            peakRunnerBytes: runnerValues.length > 0 ? Math.max(...runnerValues) : null,
            lastRunnerBytes: runnerValues.at(-1) ?? null,
            baselineRendererJsHeapUsedBytes,
            peakRendererJsHeapUsedBytes,
            lastRendererJsHeapUsedBytes: rendererJsHeapValues.at(-1) ?? null,
            rendererJsHeapDeltaBytes: baselineRendererJsHeapUsedBytes !== null
                && peakRendererJsHeapUsedBytes !== null
                ? Math.max(0, peakRendererJsHeapUsedBytes - baselineRendererJsHeapUsedBytes)
                : null,
            samples,
        };
        return result;
    }};
}
