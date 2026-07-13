import type {
    IDjvuConvertResult,
    IDjvuOpenResult,
    TDocumentOutputJobState,
} from '@contracts/electronApiDjvu';

const DEFAULT_TERMINAL_JOB_TTL_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_TERMINAL_JOBS = 64;

interface ITerminalBrowserDjvuJob {
    kind: 'open' | 'convert';
    promise: Promise<IDjvuOpenResult> | Promise<IDjvuConvertResult>;
    timer: ReturnType<typeof setTimeout>;
}

function getErrorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

export class BrowserDurableDjvuJobs {
    readonly #openJobs = new Map<string, Promise<IDjvuOpenResult>>();
    readonly #convertJobs = new Map<string, Promise<IDjvuConvertResult>>();
    readonly #states = new Map<string, TDocumentOutputJobState>();
    readonly #terminalJobs = new Map<string, ITerminalBrowserDjvuJob>();

    constructor(
        private readonly terminalJobTtlMs = DEFAULT_TERMINAL_JOB_TTL_MS,
        private readonly maxTerminalJobs = DEFAULT_MAX_TERMINAL_JOBS,
    ) {}

    startOpen(
        jobId: string,
        requestId: string,
        run: () => Promise<IDjvuOpenResult>,
    ) {
        if (!this.#openJobs.has(jobId)) {
            this.#states.set(jobId, this.#createState(jobId, 'djvu-open', 'loading'));
            const job = Promise.resolve().then(run).catch((error: unknown): IDjvuOpenResult => ({
                success: false,
                error: getErrorMessage(error),
            })).then((result) => {
                this.#states.set(jobId, this.#finishState(jobId, 'djvu-open', 'loading', result));
                const normalizedResult = {
                    ...result,
                    jobId,
                };
                this.#retainTerminalJob(jobId, 'open', job);
                return normalizedResult;
            });
            this.#openJobs.set(jobId, job);
        }
        return {
            jobId,
            requestId,
        };
    }

    awaitOpen(jobId: string) {
        const job = this.#openJobs.get(jobId);
        if (!job) throw new Error(`Unknown browser DjVu open job: ${jobId}`);
        return job;
    }

    startConvert(
        jobId: string,
        requestId: string,
        run: () => Promise<IDjvuConvertResult>,
    ) {
        if (!this.#convertJobs.has(jobId)) {
            this.#states.set(jobId, this.#createState(jobId, 'djvu-convert', 'converting'));
            const job = Promise.resolve().then(run).catch((error: unknown): IDjvuConvertResult => ({
                success: false,
                error: getErrorMessage(error),
            })).then((result) => {
                this.#states.set(jobId, this.#finishState(jobId, 'djvu-convert', 'converting', result));
                const normalizedResult = {
                    ...result,
                    jobId,
                };
                this.#retainTerminalJob(jobId, 'convert', job);
                return normalizedResult;
            });
            this.#convertJobs.set(jobId, job);
        }
        return {
            jobId,
            requestId,
        };
    }

    awaitConvert(jobId: string) {
        const job = this.#convertJobs.get(jobId);
        if (!job) throw new Error(`Unknown browser DjVu conversion job: ${jobId}`);
        return job;
    }

    getState(jobId: string) {
        return this.#states.get(jobId) ?? null;
    }

    clearForTests() {
        for (const terminal of this.#terminalJobs.values()) {
            clearTimeout(terminal.timer);
        }
        this.#terminalJobs.clear();
        this.#openJobs.clear();
        this.#convertJobs.clear();
        this.#states.clear();
    }

    #retainTerminalJob(
        jobId: string,
        kind: 'open' | 'convert',
        promise: Promise<IDjvuOpenResult> | Promise<IDjvuConvertResult>,
    ) {
        const previous = this.#terminalJobs.get(jobId);
        if (previous) {
            clearTimeout(previous.timer);
            this.#terminalJobs.delete(jobId);
        }
        const timer = setTimeout(() => this.#deleteTerminalJob(jobId, promise), this.terminalJobTtlMs);
        timer.unref?.();
        this.#terminalJobs.set(jobId, {
            kind,
            promise,
            timer,
        });
        while (this.#terminalJobs.size > this.maxTerminalJobs) {
            const oldestJobId = this.#terminalJobs.keys().next().value;
            if (!oldestJobId) {
                break;
            }
            this.#deleteTerminalJob(oldestJobId);
        }
    }

    #deleteTerminalJob(jobId: string, expectedPromise?: Promise<IDjvuOpenResult> | Promise<IDjvuConvertResult>) {
        const terminal = this.#terminalJobs.get(jobId);
        if (!terminal || expectedPromise && terminal.promise !== expectedPromise) {
            return;
        }
        clearTimeout(terminal.timer);
        this.#terminalJobs.delete(jobId);
        if (terminal.kind === 'open' && this.#openJobs.get(jobId) === terminal.promise) {
            this.#openJobs.delete(jobId);
        }
        if (terminal.kind === 'convert' && this.#convertJobs.get(jobId) === terminal.promise) {
            this.#convertJobs.delete(jobId);
        }
        this.#states.delete(jobId);
    }

    #createState(
        jobId: string,
        operation: 'djvu-open' | 'djvu-convert',
        phase: 'loading' | 'converting',
    ): TDocumentOutputJobState {
        return {
            jobId,
            operation,
            status: 'running',
            progress: {
                jobId,
                phase,
                percent: 0,
            },
            updatedAtMs: Date.now(),
        };
    }

    #finishState(
        jobId: string,
        operation: 'djvu-open' | 'djvu-convert',
        phase: 'loading' | 'converting',
        result: IDjvuOpenResult | IDjvuConvertResult,
    ): TDocumentOutputJobState {
        return {
            jobId,
            operation,
            status: result.success ? 'completed' : 'failed',
            progress: {
                jobId,
                phase,
                percent: result.success ? 100 : 0,
            },
            updatedAtMs: Date.now(),
            ...(result.success || !result.error ? {} : {error: result.error}),
            ...('pdfPath' in result && result.pdfPath ? {artifactPath: result.pdfPath} : {}),
        };
    }
}

export const browserDurableDjvuJobs = new BrowserDurableDjvuJobs();
