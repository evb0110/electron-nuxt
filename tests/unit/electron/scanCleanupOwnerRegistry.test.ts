import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {EventEmitter} from 'node:events';
import {
    createOwnerScopedJobRegistry,
    type IScanCleanupJobSubscriber,
} from '@electron/features/scan-cleanup/createOwnerScopedJobRegistry';

type TTestSubscriber = IScanCleanupJobSubscriber & {send: ReturnType<typeof vi.fn>};

function sender(id: number) {
    const value = Object.assign(new EventEmitter(), {
        id,
        isDestroyed: () => false,
        send: vi.fn(),
    }) as TTestSubscriber & EventEmitter;
    return {
        value,
        destroy: () => value.emit('destroyed'),
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('scan cleanup owner-scoped job registry', () => {
    it('fences same-document jobs by window and tab owner and drops destroyed subscribers', () => {
        const registry = createOwnerScopedJobRegistry<TTestSubscriber, {subscribers: Set<TTestSubscriber>}>();
        const first = sender(1);
        const second = sender(2);
        const job = {subscribers: new Set<TTestSubscriber>()};
        registry.add('job-1', first.value, {
            ownerId: 'tab-a',
            documentRevision: 'revision-1',
        }, job);

        expect(registry.getOwned('job-1', second.value, {
            ownerId: 'tab-a',
            documentRevision: 'revision-1',
        })).toBeNull();
        expect(registry.getOwned('job-1', first.value, {
            ownerId: 'tab-b',
            documentRevision: 'revision-1',
        })).toBeNull();
        expect(registry.getOwned('job-1', first.value, {
            ownerId: 'tab-a',
            documentRevision: 'stale-revision',
        })).toBeNull();
        expect(registry.getOwned('job-1', first.value, {
            ownerId: 'tab-a',
            documentRevision: 'revision-1',
        })).toBe(job);
        expect(job.subscribers.size).toBe(1);
        first.destroy();
        expect(job.subscribers.size).toBe(0);
    });

    it('expires terminal jobs after the configured reconnect TTL', () => {
        vi.useFakeTimers();
        const registry = createOwnerScopedJobRegistry<TTestSubscriber, {subscribers: Set<TTestSubscriber>}>(25);
        const owner = sender(1);
        registry.add('job-1', owner.value, {
            ownerId: 'tab-a',
            documentRevision: 'revision-1',
        }, {subscribers: new Set()});
        registry.expireTerminal('job-1');
        vi.advanceTimersByTime(24);
        expect(registry.size).toBe(1);
        vi.advanceTimersByTime(1);
        expect(registry.size).toBe(0);
    });

    it('uses one destroyed listener per sender and removes it after all jobs expire', () => {
        vi.useFakeTimers();
        const registry = createOwnerScopedJobRegistry<TTestSubscriber, {subscribers: Set<TTestSubscriber>}>(25);
        const owner = sender(1);
        const ownership = {
            ownerId: 'tab-a',
            documentRevision: 'revision-1',
        };
        registry.add('job-1', owner.value, ownership, {subscribers: new Set()});
        registry.add('job-2', owner.value, ownership, {subscribers: new Set()});

        expect(owner.value.listenerCount('destroyed')).toBe(1);
        registry.subscribe('job-1', owner.value, ownership);
        registry.subscribe('job-1', owner.value, ownership);
        registry.subscribe('job-2', owner.value, ownership);
        expect(owner.value.listenerCount('destroyed')).toBe(1);

        registry.expireTerminal('job-1');
        vi.advanceTimersByTime(25);
        expect(owner.value.listenerCount('destroyed')).toBe(1);
        registry.expireTerminal('job-2');
        vi.advanceTimersByTime(25);
        expect(owner.value.listenerCount('destroyed')).toBe(0);
    });
});
