import {createLatestWinsPdfMetricHydrator} from '@app/modules/pdf-viewer/runtime/navigation/createLatestWinsPdfMetricHydrator';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

async function flushPromises() {
    await Promise.resolve();
    await Promise.resolve();
}

describe('createLatestWinsPdfMetricHydrator', () => {
    it('runs one non-abortable read at a time and retains only the latest pending page', async () => {
        const reads = new Map<number, ReturnType<typeof deferred<boolean>>>();
        const hydrate = vi.fn((page: number) => {
            const read = deferred<boolean>();
            reads.set(page, read);
            return read.promise;
        });
        const coordinator = createLatestWinsPdfMetricHydrator(hydrate);

        const first = coordinator.ensure(1, new AbortController().signal);
        const superseded = coordinator.ensure(2, new AbortController().signal);
        const latest = coordinator.ensure(3, new AbortController().signal);

        await expect(superseded).rejects.toMatchObject({name: 'AbortError'});
        expect(hydrate.mock.calls).toEqual([[1]]);

        reads.get(1)!.resolve(true);
        await expect(first).resolves.toBe(true);
        await flushPromises();
        expect(hydrate.mock.calls).toEqual([
            [1],
            [3],
        ]);

        reads.get(3)!.resolve(false);
        await expect(latest).resolves.toBe(false);
    });

    it('settles an aborted active subscriber without waiting for its underlying read', async () => {
        const reads = new Map<number, ReturnType<typeof deferred<boolean>>>();
        const coordinator = createLatestWinsPdfMetricHydrator((page) => {
            const read = deferred<boolean>();
            reads.set(page, read);
            return read.promise;
        });
        const controller = new AbortController();
        const active = coordinator.ensure(4, controller.signal);

        controller.abort();
        await expect(active).rejects.toMatchObject({name: 'AbortError'});

        const next = coordinator.ensure(5, new AbortController().signal);
        expect(reads.has(5)).toBe(false);
        reads.get(4)!.resolve(true);
        await flushPromises();
        expect(reads.has(5)).toBe(true);
        reads.get(5)!.resolve(true);
        await expect(next).resolves.toBe(true);
    });

    it('coalesces a latest request for the page that is already hydrating', async () => {
        const read = deferred<boolean>();
        const hydrate = vi.fn(() => read.promise);
        const coordinator = createLatestWinsPdfMetricHydrator(hydrate);

        const first = coordinator.ensure(8, new AbortController().signal);
        const stalePending = coordinator.ensure(9, new AbortController().signal);
        const joined = coordinator.ensure(8, new AbortController().signal);

        await expect(stalePending).rejects.toMatchObject({name: 'AbortError'});
        expect(hydrate).toHaveBeenCalledOnce();
        read.resolve(true);
        await expect(Promise.all([
            first,
            joined,
        ])).resolves.toEqual([
            true,
            true,
        ]);
    });

    it('collapses a 25-request abort storm to the active and final page', async () => {
        const reads: Array<ReturnType<typeof deferred<boolean>>> = [];
        const pages: number[] = [];
        const coordinator = createLatestWinsPdfMetricHydrator((page) => {
            pages.push(page);
            const read = deferred<boolean>();
            reads.push(read);
            return read.promise;
        });
        const controllers: AbortController[] = [];
        const requests: Array<Promise<boolean>> = [];

        for (let page = 1; page <= 25; page += 1) {
            controllers.at(-1)?.abort();
            const controller = new AbortController();
            controllers.push(controller);
            requests.push(coordinator.ensure(page, controller.signal));
        }

        const superseded = await Promise.allSettled(requests.slice(0, -1));
        expect(superseded.every(result => result.status === 'rejected'
            && result.reason instanceof DOMException
            && result.reason.name === 'AbortError')).toBe(true);
        expect(pages).toEqual([1]);

        reads[0]!.resolve(true);
        await flushPromises();
        expect(pages).toEqual([
            1,
            25,
        ]);
        reads[1]!.resolve(true);
        await expect(requests.at(-1)).resolves.toBe(true);
    });

    it('rejects subscribers on disposal while allowing the active read to finish privately', async () => {
        const read = deferred<boolean>();
        const coordinator = createLatestWinsPdfMetricHydrator(() => read.promise);
        const active = coordinator.ensure(1, new AbortController().signal);
        const pending = coordinator.ensure(2, new AbortController().signal);

        coordinator.dispose();

        await expect(active).rejects.toMatchObject({name: 'AbortError'});
        await expect(pending).rejects.toMatchObject({name: 'AbortError'});
        read.resolve(true);
        await flushPromises();
    });
});
