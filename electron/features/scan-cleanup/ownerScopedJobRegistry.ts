export const SCAN_CLEANUP_TERMINAL_JOB_TTL_MS = 60_000;

export interface IScanCleanupJobSubscriber {
    id: number;
    isDestroyed: () => boolean;
    once: (event: 'destroyed', listener: () => void) => unknown;
    removeListener: (event: 'destroyed', listener: () => void) => unknown;
}

export interface IScanCleanupJobOwner {
    documentRevision: string;
    ownerId: string;
}

interface IRegistryEntry<TSubscriber, TJob extends {subscribers: Set<TSubscriber>}> extends IScanCleanupJobOwner {
    job: TJob;
    senderId: number;
    terminalTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Job ids are opaque but are not authority. Every lookup is fenced by the
 * renderer tab owner plus its WebContents, and terminal state lives only long
 * enough for a reconnect. Subscriber references are removed when a window dies.
 */
export function createOwnerScopedJobRegistry<
    TSubscriber extends IScanCleanupJobSubscriber,
    TJob extends {subscribers: Set<TSubscriber>},
>(
    terminalTtlMs = SCAN_CLEANUP_TERMINAL_JOB_TTL_MS,
) {
    const entries = new Map<string, IRegistryEntry<TSubscriber, TJob>>();
    const senderEntries = new Map<TSubscriber, {
        destroyedListener: () => void;
        entries: Set<IRegistryEntry<TSubscriber, TJob>>;
    }>();

    function addSubscriber(entry: IRegistryEntry<TSubscriber, TJob>, sender: TSubscriber) {
        entry.job.subscribers.add(sender);
        const existing = senderEntries.get(sender);
        if (existing) {
            existing.entries.add(entry);
            return;
        }
        const senderJobEntries = new Set([entry]);
        const destroyedListener = () => {
            for (const senderEntry of senderJobEntries) {
                senderEntry.job.subscribers.delete(sender);
            }
            senderJobEntries.clear();
            senderEntries.delete(sender);
        };
        const state = {
            destroyedListener,
            entries: senderJobEntries,
        };
        senderEntries.set(sender, state);
        sender.once('destroyed', state.destroyedListener);
    }

    function detachEntry(entry: IRegistryEntry<TSubscriber, TJob>) {
        for (const sender of entry.job.subscribers) {
            const state = senderEntries.get(sender);
            if (!state) {
                continue;
            }
            state.entries.delete(entry);
            entry.job.subscribers.delete(sender);
            if (state.entries.size === 0) {
                sender.removeListener('destroyed', state.destroyedListener);
                senderEntries.delete(sender);
            }
        }
    }

    function ownedEntry(jobId: string, sender: TSubscriber, owner: IScanCleanupJobOwner) {
        const entry = entries.get(jobId);
        return entry
            && entry.senderId === sender.id
            && entry.ownerId === owner.ownerId
            && entry.documentRevision === owner.documentRevision
            ? entry
            : null;
    }

    return {
        add(jobId: string, sender: TSubscriber, owner: IScanCleanupJobOwner, job: TJob) {
            const previous = entries.get(jobId);
            if (previous) {
                if (previous.terminalTimer) clearTimeout(previous.terminalTimer);
                detachEntry(previous);
            }
            const entry: IRegistryEntry<TSubscriber, TJob> = {
                ...owner,
                job,
                senderId: sender.id,
                terminalTimer: null,
            };
            entries.set(jobId, entry);
            addSubscriber(entry, sender);
        },
        get(jobId: string) {
            return entries.get(jobId)?.job ?? null;
        },
        getOwned(jobId: string, sender: TSubscriber, owner: IScanCleanupJobOwner) {
            return ownedEntry(jobId, sender, owner)?.job ?? null;
        },
        subscribe(jobId: string, sender: TSubscriber, owner: IScanCleanupJobOwner) {
            const entry = ownedEntry(jobId, sender, owner);
            if (!entry) {
                return null;
            }
            addSubscriber(entry, sender);
            return entry.job;
        },
        expireTerminal(jobId: string) {
            const entry = entries.get(jobId);
            if (!entry || entry.terminalTimer) {
                return;
            }
            entry.terminalTimer = setTimeout(() => {
                if (entries.get(jobId) === entry) {
                    entries.delete(jobId);
                    detachEntry(entry);
                }
            }, terminalTtlMs);
            entry.terminalTimer.unref?.();
        },
        get size() {
            return entries.size;
        },
    };
}
