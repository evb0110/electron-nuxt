import type { Page } from 'puppeteer-core';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IAnnotationSyncAutomationActivity } from '@app/types/annotations';
import {
    readAnnotationSyncRequestSeq,
    waitForAnnotationSyncIdle,
} from '@tests/e2e/electron/helpers/viewerAnnotations';

type TIdlePredicate = (baselineSeq: number) => unknown;

function setRendererWindow(value: unknown) {
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value,
        writable: true,
    });
}

function setActivityLedger(activity: IAnnotationSyncAutomationActivity | null) {
    setRendererWindow(activity ? { __evbAnnotationSyncActivity: activity } : {});
}

function createBarrierPage({ waitRejection }: {waitRejection?: Error} = {}) {
    const predicates: TIdlePredicate[] = [];
    const evaluate = vi.fn(async (pageFunction: (...args: unknown[]) => unknown) => pageFunction());
    const waitForFunction = vi.fn(async (pageFunction: TIdlePredicate) => {
        predicates.push(pageFunction);
        if (waitRejection) {
            throw waitRejection;
        }
        return undefined;
    });
    const page = Object.create(null) as Page;
    Object.defineProperty(page, 'evaluate', { value: evaluate });
    Object.defineProperty(page, 'waitForFunction', { value: waitForFunction });
    return {
        page,
        predicates,
    };
}

async function captureIdlePredicate(baselineSeq: number) {
    const {
        page,
        predicates,
    } = createBarrierPage();
    // The helper reads the ledger once more on the way out; the predicate it
    // installed is what the cases below actually exercise.
    setActivityLedger(createLedger());
    await waitForAnnotationSyncIdle(page, baselineSeq);
    const predicate = predicates.at(0);
    if (!predicate) {
        throw new Error('The idle barrier did not install a page predicate');
    }
    return predicate;
}

function createLedger(overrides: Partial<IAnnotationSyncAutomationActivity> = {}): IAnnotationSyncAutomationActivity {
    return {
        pendingDebounces: 0,
        requestSeq: 5,
        runningPasses: 0,
        servicedSeq: 5,
        ...overrides,
    };
}

/**
 * The barrier is the only thing standing between the resurrection assertions
 * and a sidebar count that settles well before the sync it is supposed to
 * prove finished, so each way the ledger can still be busy has to keep it
 * waiting — and a ledger that never appears has to keep it waiting too, rather
 * than reading an absent automation grant as "already idle".
 */
describe('annotation sync idle barrier', () => {
    const originalWindow = Reflect.get(globalThis, 'window') as unknown;

    afterEach(() => {
        setRendererWindow(originalWindow);
        vi.restoreAllMocks();
    });

    it('waits until a sync requested after the baseline has been fully serviced', async () => {
        const predicate = await captureIdlePredicate(4);

        setActivityLedger(createLedger());
        expect(predicate(4)).toBe(true);

        // Nothing new was requested after the baseline: the only serviced sync
        // is the one that had already finished before the mutation.
        setActivityLedger(createLedger({
            requestSeq: 4,
            servicedSeq: 4,
        }));
        expect(predicate(4)).toBe(false);
    });

    it('keeps waiting when a requested sync has not been serviced', async () => {
        const predicate = await captureIdlePredicate(4);

        setActivityLedger(createLedger({
            requestSeq: 6,
            servicedSeq: 5,
            runningPasses: 0,
            pendingDebounces: 0,
        }));

        expect(predicate(4)).toBe(false);
    });

    it('keeps waiting while a pass runs, a debounce is armed, or the ledger is absent', async () => {
        const predicate = await captureIdlePredicate(4);

        setActivityLedger(createLedger({
            runningPasses: 1,
            servicedSeq: 4,
        }));
        expect(predicate(4)).toBe(false);

        setActivityLedger(createLedger({
            pendingDebounces: 1,
            requestSeq: 6,
            servicedSeq: 5,
        }));
        expect(predicate(4)).toBe(false);

        // A serviced counter that caught up while a debounce is still armed is
        // the case a request/serviced comparison alone would call idle.
        setActivityLedger(createLedger({ pendingDebounces: 1 }));
        expect(predicate(4)).toBe(false);

        setActivityLedger(null);
        expect(predicate(4)).toBe(false);
    });

    it('reports the ledger state when the wait times out', async () => {
        const ledger = createLedger({
            pendingDebounces: 1,
            requestSeq: 7,
            servicedSeq: 5,
        });
        setActivityLedger(ledger);
        const { page } = createBarrierPage({ waitRejection: new Error('waiting for function failed: timeout') });

        await expect(waitForAnnotationSyncIdle(page, 4)).rejects.toThrow(
            /Timed out waiting for an annotation sync after request 4 to settle: .*"pendingDebounces":1/u,
        );
    });

    it('reads the request counter and falls back to zero without a ledger', async () => {
        const { page } = createBarrierPage();

        setActivityLedger(createLedger({ requestSeq: 9 }));
        expect(await readAnnotationSyncRequestSeq(page)).toBe(9);

        setActivityLedger(null);
        expect(await readAnnotationSyncRequestSeq(page)).toBe(0);
    });
});
