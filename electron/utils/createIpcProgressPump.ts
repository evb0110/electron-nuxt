interface IProgressPumpTarget<TPayload> {
    isDestroyed?: () => boolean;
    send: (channel: string, payload: TPayload) => void;
}

export interface IIpcProgressPumpOptions<TPayload> {
    channel: string;
    getTarget: () => IProgressPumpTarget<TPayload> | null | undefined;
    getKey: (payload: TPayload) => string;
    isTerminal?: (payload: TPayload) => boolean;
    intervalMs?: number;
    terminalRetentionMs?: number;
    onError?: (error: unknown) => void;
    onIdle?: () => void;
}

const DEFAULT_PROGRESS_PUMP_INTERVAL_MS = 50;
const DEFAULT_TERMINAL_PROGRESS_RETENTION_MS = 30_000;

interface IRetainedProgress<TPayload> {
    payload: TPayload;
    terminal: boolean;
    timer: ReturnType<typeof setTimeout> | null;
}

export function createIpcProgressPump<TPayload>(options: IIpcProgressPumpOptions<TPayload>) {
    const pendingByKey = new Map<string, TPayload>();
    const timersByKey = new Map<string, ReturnType<typeof setTimeout>>();
    const subscribers = new Set<IProgressPumpTarget<TPayload>>();
    const retainedByKey = new Map<string, IRetainedProgress<TPayload>>();
    const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_PROGRESS_PUMP_INTERVAL_MS);
    const terminalRetentionMs = Math.max(0, options.terminalRetentionMs ?? DEFAULT_TERMINAL_PROGRESS_RETENTION_MS);

    function notifyIdleIfEmpty() {
        if (pendingByKey.size === 0 && timersByKey.size === 0 && retainedByKey.size === 0) {
            options.onIdle?.();
        }
    }

    function sendToTarget(target: IProgressPumpTarget<TPayload> | null | undefined, payload: TPayload) {
        if (!target || target.isDestroyed?.() === true) {
            return;
        }
        try {
            target.send(options.channel, payload);
        } catch (error) {
            options.onError?.(error);
        }
    }

    function send(payload: TPayload) {
        sendToTarget(options.getTarget(), payload);
        for (const subscriber of subscribers) {
            sendToTarget(subscriber, payload);
        }
    }

    function clearRetainedTimer(key: string) {
        const retained = retainedByKey.get(key);
        if (retained?.timer) {
            clearTimeout(retained.timer);
            retained.timer = null;
        }
    }

    function retain(key: string, payload: TPayload) {
        const terminal = options.isTerminal?.(payload) === true;
        clearRetainedTimer(key);

        let timer: ReturnType<typeof setTimeout> | null = null;
        if (terminal) {
            timer = setTimeout(() => {
                retainedByKey.delete(key);
                notifyIdleIfEmpty();
            }, terminalRetentionMs);
            timer.unref?.();
        }

        retainedByKey.set(key, {
            payload,
            terminal,
            timer,
        });
    }

    function clearTimer(key: string) {
        const timer = timersByKey.get(key);
        if (timer) {
            clearTimeout(timer);
            timersByKey.delete(key);
        }
    }

    function flush(key: string) {
        timersByKey.delete(key);
        const payload = pendingByKey.get(key);
        if (payload === undefined) {
            return;
        }
        pendingByKey.delete(key);
        retain(key, payload);
        send(payload);
        if (pendingByKey.has(key)) {
            scheduleFlush(key);
        }
    }

    function scheduleFlush(key: string) {
        const timer = setTimeout(() => {
            flush(key);
        }, intervalMs);
        timer.unref?.();
        timersByKey.set(key, timer);
    }

    function enqueue(payload: TPayload) {
        const key = options.getKey(payload);
        if (options.isTerminal?.(payload) === true) {
            pendingByKey.delete(key);
            clearTimer(key);
            retain(key, payload);
            send(payload);
            return;
        }

        pendingByKey.set(key, payload);
        if (timersByKey.has(key)) {
            retain(key, payload);
            return;
        }
        pendingByKey.delete(key);
        retain(key, payload);
        send(payload);
        scheduleFlush(key);
    }

    function clearKey(key: string) {
        pendingByKey.delete(key);
        clearTimer(key);
        const retained = retainedByKey.get(key);
        if (retained && !retained.terminal) {
            clearRetainedTimer(key);
            retainedByKey.delete(key);
        }
        notifyIdleIfEmpty();
    }

    function clear() {
        for (const timer of timersByKey.values()) {
            clearTimeout(timer);
        }
        timersByKey.clear();
        pendingByKey.clear();
        subscribers.clear();
        for (const [
            key,
            retained,
        ] of retainedByKey.entries()) {
            if (!retained.terminal) {
                clearRetainedTimer(key);
                retainedByKey.delete(key);
            }
        }
        notifyIdleIfEmpty();
    }

    function dispose() {
        clear();
        for (const key of retainedByKey.keys()) {
            clearRetainedTimer(key);
        }
        retainedByKey.clear();
        notifyIdleIfEmpty();
    }

    function subscribe(target: IProgressPumpTarget<TPayload>) {
        if (target.isDestroyed?.() === true) {
            return;
        }
        subscribers.add(target);
        for (const {payload} of retainedByKey.values()) {
            sendToTarget(target, payload);
        }

        return () => {
            subscribers.delete(target);
        };
    }

    return {
        enqueue,
        flush,
        subscribe,
        clearKey,
        clear,
        dispose,
    };
}
