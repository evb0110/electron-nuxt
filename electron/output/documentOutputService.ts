import { randomUUID } from 'node:crypto';
import type {
    IDocumentOutputProgress,
    IDocumentOutputService,
    IDocumentOutputStartOptions,
    TDocumentOutputJobState,
} from '@contracts/documentOutput';

const TERMINAL_RETENTION_MS = 60 * 60 * 1_000;

interface IActiveOutputJob {
    abortController: AbortController;
    state: TDocumentOutputJobState;
}

function resolveOutputJobId(requestedJobId?: string) {
    const normalizedJobId = requestedJobId?.trim();
    if (normalizedJobId) {
        return normalizedJobId;
    }
    return `document-output-${randomUUID()}`;
}

export class DocumentOutputService implements IDocumentOutputService {
    readonly #jobs = new Map<string, IActiveOutputJob>();
    readonly #listeners = new Map<string, Set<(state: TDocumentOutputJobState) => void>>();
    readonly #cleanupTimers = new Map<string, ReturnType<typeof setTimeout>>();

    start(options: IDocumentOutputStartOptions) {
        const jobId = resolveOutputJobId(options.jobId);
        const existing = this.#jobs.get(jobId);
        if (existing && !this.#isTerminal(existing.state)) {
            return {
                jobId,
                signal: existing.abortController.signal,
            };
        }
        const abortController = new AbortController();
        this.#publish({
            jobId,
            operation: options.operation,
            sourceKind: options.sourceKind,
            status: 'queued',
            progress: {
                phase: options.initialPhase ?? 'queued',
                percent: 0,
            },
            updatedAtMs: Date.now(),
        }, abortController, false);
        return {
            jobId,
            signal: abortController.signal,
        };
    }

    getState(jobId: string) {
        return this.#jobs.get(jobId.trim())?.state ?? null;
    }

    subscribe(jobId: string, listener: (state: TDocumentOutputJobState) => void) {
        const normalizedJobId = jobId.trim();
        const listeners = this.#listeners.get(normalizedJobId) ?? new Set();
        listeners.add(listener);
        this.#listeners.set(normalizedJobId, listeners);
        return () => {
            listeners.delete(listener);
            if (listeners.size === 0) this.#listeners.delete(normalizedJobId);
        };
    }

    cancel(jobId: string, reason = 'Document output canceled') {
        const job = this.#jobs.get(jobId.trim());
        if (!job || this.#isTerminal(job.state)) {
            return false;
        }
        job.abortController.abort(new Error(reason));
        this.finish(jobId, 'canceled', reason);
        return true;
    }

    update(jobId: string, progress: IDocumentOutputProgress) {
        const job = this.#requireJob(jobId);
        if (this.#isTerminal(job.state)) {
            return;
        }
        this.#publish({
            ...job.state,
            status: 'running',
            progress,
            updatedAtMs: Date.now(),
        }, job.abortController);
    }

    handoff(jobId: string, artifactPath: string, progress?: IDocumentOutputProgress) {
        const job = this.#requireJob(jobId);
        if (this.#isTerminal(job.state)) {
            return;
        }
        this.#publish({
            ...job.state,
            status: 'handoff',
            artifactPath,
            progress: progress ?? job.state.progress,
            updatedAtMs: Date.now(),
        }, job.abortController);
    }

    finish(jobId: string, status: 'completed' | 'canceled' | 'failed', error?: string) {
        const job = this.#requireJob(jobId);
        if (this.#isTerminal(job.state)) {
            return;
        }
        const artifactPath = 'artifactPath' in job.state ? job.state.artifactPath : undefined;
        this.#publish({
            jobId: job.state.jobId,
            operation: job.state.operation,
            sourceKind: job.state.sourceKind,
            status,
            progress: {
                ...job.state.progress,
                percent: status === 'completed' ? 100 : job.state.progress.percent,
                ...(error ? {error} : {}),
            },
            updatedAtMs: Date.now(),
            ...(artifactPath ? {artifactPath} : {}),
            ...(error ? {error} : {}),
        }, job.abortController);
        this.#scheduleCleanup(jobId);
    }

    clearForTests() {
        for (const timer of this.#cleanupTimers.values()) clearTimeout(timer);
        this.#cleanupTimers.clear();
        this.#jobs.clear();
        this.#listeners.clear();
    }

    #requireJob(jobId: string) {
        const job = this.#jobs.get(jobId.trim());
        if (!job) throw new Error(`Unknown document output job: ${jobId}`);
        return job;
    }

    #publish(state: TDocumentOutputJobState, abortController?: AbortController, notify = true) {
        const controller = abortController ?? this.#jobs.get(state.jobId)?.abortController ?? new AbortController();
        this.#jobs.set(state.jobId, {
            abortController: controller,
            state,
        });
        if (notify) {
            for (const listener of this.#listeners.get(state.jobId) ?? []) listener(state);
        }
    }

    #scheduleCleanup(jobId: string) {
        const previous = this.#cleanupTimers.get(jobId);
        if (previous) clearTimeout(previous);
        const timer = setTimeout(() => {
            this.#cleanupTimers.delete(jobId);
            this.#jobs.delete(jobId);
            this.#listeners.delete(jobId);
        }, TERMINAL_RETENTION_MS);
        timer.unref?.();
        this.#cleanupTimers.set(jobId, timer);
    }

    #isTerminal(state: TDocumentOutputJobState) {
        return state.status === 'completed' || state.status === 'failed' || state.status === 'canceled';
    }
}

export const documentOutputService = new DocumentOutputService();
