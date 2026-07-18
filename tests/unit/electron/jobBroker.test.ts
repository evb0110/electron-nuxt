import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    JobBroker,
    type IJobBrokerRequest,
    MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES,
    resolveMainJobBrokerCapacity,
} from '@electron/resources/jobBroker';

const CAPACITY = {
    cpuTokens: 2,
    estimatedResidentBytes: 200,
    nativeProcesses: 2,
    ioWeight: 2,
};

function createRequest(overrides: Partial<IJobBrokerRequest> = {}): IJobBrokerRequest {
    return {
        ownerId: 'renderer-1',
        kind: 'preview',
        priority: 'user',
        resources: {
            cpuTokens: 1,
            estimatedResidentBytes: 100,
            nativeProcesses: 1,
            ioWeight: 1,
        },
        ...overrides,
    };
}

describe('JobBroker', () => {
    it.each([
        1,
        2,
        4,
        6,
        8,
    ])('admits the largest supported single job on a %i-CPU host', async (cpuCount) => {
        const capacity = resolveMainJobBrokerCapacity(cpuCount, 8 * 1024 * 1024 * 1024);
        const broker = new JobBroker(capacity);
        const lease = await broker.acquire(createRequest({resources: {...MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES}}));

        expect(capacity.cpuTokens).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.cpuTokens);
        expect(capacity.estimatedResidentBytes).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.estimatedResidentBytes);
        expect(capacity.nativeProcesses).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.nativeProcesses);
        expect(capacity.ioWeight).toBeGreaterThanOrEqual(MAIN_JOB_BROKER_MAX_SINGLE_JOB_RESOURCES.ioWeight);
        expect(lease.release()).toBe(true);
    });

    it('holds work until the full resource vector is available', async () => {
        const broker = new JobBroker(CAPACITY);
        const first = await broker.acquire(createRequest({resources: CAPACITY}));
        let secondGranted = false;
        const secondPromise = broker.acquire(createRequest()).then((lease) => {
            secondGranted = true;
            return lease;
        });

        await Promise.resolve();
        expect(secondGranted).toBe(false);
        expect(first.release()).toBe(true);
        const second = await secondPromise;
        expect(secondGranted).toBe(true);
        expect(second.release()).toBe(true);
    });

    it('prioritizes visible work while preserving FIFO within a priority', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        });
        const blocker = await broker.acquire(createRequest());
        const order: string[] = [];
        const background = broker.acquire(createRequest({
            ownerId: 'background-owner',
            priority: 'background',
        })).then((lease) => {
            order.push('background');
            return lease;
        });
        const visible = broker.acquire(createRequest({
            ownerId: 'visible-owner',
            priority: 'visible',
        })).then((lease) => {
            order.push('visible');
            return lease;
        });

        blocker.release();
        const visibleLease = await visible;
        expect(order).toEqual(['visible']);
        visibleLease.release();
        const backgroundLease = await background;
        expect(order).toEqual([
            'visible',
            'background',
        ]);
        backgroundLease.release();
    });

    it('enforces per-owner feature caps while allowing another renderer through', async () => {
        const broker = new JobBroker(CAPACITY);
        const first = await broker.acquire(createRequest({perOwnerLimit: 1}));
        let sameOwnerGranted = false;
        const sameOwner = broker.acquire(createRequest({perOwnerLimit: 1})).then((lease) => {
            sameOwnerGranted = true;
            return lease;
        });
        const otherOwner = await broker.acquire(createRequest({
            ownerId: 'renderer-2',
            perOwnerLimit: 1,
        }));

        expect(sameOwnerGranted).toBe(false);
        otherOwner.release();
        first.release();
        const sameOwnerLease = await sameOwner;
        sameOwnerLease.release();
    });

    it('enforces an admission-only owner cap without consuming nested-work resources', async () => {
        const broker = new JobBroker(CAPACITY);
        const admissionResources = {
            cpuTokens: 0,
            estimatedResidentBytes: 0,
            nativeProcesses: 0,
            ioWeight: 0,
        };
        const first = await broker.acquire(createRequest({
            kind: 'combine-pdf',
            perOwnerLimit: 1,
            resources: admissionResources,
        }));
        let secondGranted = false;
        const secondPromise = broker.acquire(createRequest({
            kind: 'combine-pdf',
            perOwnerLimit: 1,
            resources: admissionResources,
        })).then((lease) => {
            secondGranted = true;
            return lease;
        });

        await Promise.resolve();
        expect(secondGranted).toBe(false);
        expect(broker.getSnapshot()).toMatchObject({
            active: 1,
            queued: 1,
            used: admissionResources,
        });

        first.release();
        const second = await secondPromise;
        expect(secondGranted).toBe(true);
        second.release();
    });

    it('removes aborted queued requests', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        });
        const blocker = await broker.acquire(createRequest());
        const controller = new AbortController();
        const queued = broker.acquire(createRequest({signal: controller.signal}));

        controller.abort(new Error('navigation ended'));
        await expect(queued).rejects.toThrow('navigation ended');
        expect(broker.getSnapshot().queued).toBe(0);
        blocker.release();
    });

    it('ages background work so sustained newer foreground work cannot starve it', async () => {
        let now = 0;
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, 100, () => now);
        const blocker = await broker.acquire(createRequest());
        const order: string[] = [];
        const background = broker.acquire(createRequest({
            ownerId: 'background-owner',
            priority: 'background',
        })).then((lease) => {
            order.push('background');
            return lease;
        });

        now = 400;
        const foreground = broker.acquire(createRequest({
            ownerId: 'foreground-owner',
            priority: 'foreground',
        })).then((lease) => {
            order.push('foreground');
            return lease;
        });

        blocker.release();
        const backgroundLease = await background;
        expect(order).toEqual(['background']);
        backgroundLease.release();
        const foregroundLease = await foreground;
        foregroundLease.release();
    });

    it('rejects jobs that can never fit without occupying the queue', async () => {
        const broker = new JobBroker(CAPACITY);

        await expect(broker.acquire(createRequest({resources: {
            ...CAPACITY,
            estimatedResidentBytes: CAPACITY.estimatedResidentBytes + 1,
        }}))).rejects.toThrow('exceeds broker capacity');
        expect(broker.getSnapshot()).toMatchObject({
            active: 0,
            queued: 0,
        });
    });

    it('bounds queued jobs globally before allocating more queue metadata', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, 5_000, Date.now, 2, 2);
        const blocker = await broker.acquire(createRequest());
        const firstQueued = broker.acquire(createRequest({ownerId: 'owner-1'}));
        const secondQueued = broker.acquire(createRequest({ownerId: 'owner-2'}));

        await expect(broker.acquire(createRequest({ownerId: 'owner-3'})))
            .rejects.toThrow('queue is full (2 jobs)');
        expect(broker.getSnapshot().queued).toBe(2);

        blocker.release();
        const firstLease = await firstQueued;
        firstLease.release();
        const secondLease = await secondQueued;
        secondLease.release();
    });

    it('bounds queued jobs per owner without blocking other owners', async () => {
        const broker = new JobBroker({
            ...CAPACITY,
            cpuTokens: 1,
        }, 5_000, Date.now, 4, 1);
        const blocker = await broker.acquire(createRequest());
        const queued = broker.acquire(createRequest({ownerId: 'owner-1'}));

        await expect(broker.acquire(createRequest({ownerId: 'owner-1'})))
            .rejects.toThrow('owner queue is full (1 jobs for owner-1)');
        const otherOwner = broker.acquire(createRequest({ownerId: 'owner-2'}));

        blocker.release();
        const queuedLease = await queued;
        queuedLease.release();
        const otherLease = await otherOwner;
        otherLease.release();
    });
});
