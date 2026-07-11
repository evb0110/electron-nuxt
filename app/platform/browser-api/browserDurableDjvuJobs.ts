import type {
    IDjvuConvertResult,
    IDjvuOpenResult,
    TDocumentOutputJobState,
} from '@contracts/electronApiDjvu';

class BrowserDurableDjvuJobs {
    readonly #openJobs = new Map<string, Promise<IDjvuOpenResult>>();
    readonly #convertJobs = new Map<string, Promise<IDjvuConvertResult>>();
    readonly #states = new Map<string, TDocumentOutputJobState>();

    startOpen(
        jobId: string,
        requestId: string,
        run: () => Promise<IDjvuOpenResult>,
    ) {
        if (!this.#openJobs.has(jobId)) {
            this.#states.set(jobId, this.#createState(jobId, 'djvu-open', 'loading'));
            this.#openJobs.set(jobId, Promise.resolve().then(run).then((result) => {
                this.#states.set(jobId, this.#finishState(jobId, 'djvu-open', 'loading', result));
                return {
                    ...result,
                    jobId,
                };
            }));
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
            this.#convertJobs.set(jobId, Promise.resolve().then(run).then((result) => {
                this.#states.set(jobId, this.#finishState(jobId, 'djvu-convert', 'converting', result));
                return result;
            }));
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
