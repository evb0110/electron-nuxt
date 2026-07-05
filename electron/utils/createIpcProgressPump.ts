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
    onError?: (error: unknown) => void;
}

const DEFAULT_PROGRESS_PUMP_INTERVAL_MS = 50;

export function createIpcProgressPump<TPayload>(options: IIpcProgressPumpOptions<TPayload>) {
    const pendingByKey = new Map<string, TPayload>();
    const latestActiveByKey = new Map<string, TPayload>();
    const timersByKey = new Map<string, ReturnType<typeof setTimeout>>();
    const subscribers = new Set<IProgressPumpTarget<TPayload>>();
    const intervalMs = Math.max(0, options.intervalMs ?? DEFAULT_PROGRESS_PUMP_INTERVAL_MS);

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
            latestActiveByKey.delete(key);
            pendingByKey.delete(key);
            clearTimer(key);
            send(payload);
            return;
        }

        latestActiveByKey.set(key, payload);
        pendingByKey.set(key, payload);
        if (timersByKey.has(key)) {
            return;
        }
        pendingByKey.delete(key);
        send(payload);
        scheduleFlush(key);
    }

    function clear() {
        for (const timer of timersByKey.values()) {
            clearTimeout(timer);
        }
        timersByKey.clear();
        pendingByKey.clear();
        latestActiveByKey.clear();
        subscribers.clear();
    }

    function subscribe(target: IProgressPumpTarget<TPayload>) {
        subscribers.add(target);
        for (const payload of latestActiveByKey.values()) {
            sendToTarget(target, payload);
        }

        return () => {
            subscribers.delete(target);
        };
    }

    return {
        enqueue,
        subscribe,
        flush,
        clear,
    };
}
