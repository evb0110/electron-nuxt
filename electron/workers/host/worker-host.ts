import type { Worker } from 'worker_threads';

export interface IWorkerHostOptions<TOutbound> {
    createWorker: () => Worker;
    parseMessage?: (message: unknown) => TOutbound | null;
    onMessage?: (message: TOutbound) => void;
    onError?: (error: Error) => void;
    onExit?: (code: number) => void;
}

export class WorkerHost<TInbound, TOutbound> {
    private worker: Worker | null = null;

    private readonly handleMessage = (message: unknown) => {
        if (!this.options.onMessage) {
            return;
        }

        const parser = this.options.parseMessage;
        if (!parser) {
            this.options.onMessage(message as TOutbound);
            return;
        }

        const parsed = parser(message);
        if (parsed !== null) {
            this.options.onMessage(parsed);
        }
    };

    private readonly handleError = (error: Error) => {
        this.options.onError?.(error);
    };

    private readonly handleExit = (code: number) => {
        this.options.onExit?.(code);
        this.cleanup();
    };

    constructor(private readonly options: IWorkerHostOptions<TOutbound>) {}

    start() {
        if (this.worker) {
            return this.worker;
        }

        this.worker = this.options.createWorker();
        this.worker.on('message', this.handleMessage);
        this.worker.on('error', this.handleError);
        this.worker.on('exit', this.handleExit);
        return this.worker;
    }

    isRunning() {
        return this.worker !== null;
    }

    postMessage(message: TInbound) {
        if (!this.worker) {
            this.start();
        }
        this.worker?.postMessage(message);
    }

    async terminate() {
        if (!this.worker) {
            return;
        }

        const current = this.worker;
        this.cleanup();
        await current.terminate();
    }

    private cleanup() {
        if (!this.worker) {
            return;
        }

        this.worker.off('message', this.handleMessage);
        this.worker.off('error', this.handleError);
        this.worker.off('exit', this.handleExit);
        this.worker = null;
    }
}
