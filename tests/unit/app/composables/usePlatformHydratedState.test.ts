import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    type Ref,
} from 'vue';
import { installNuxtStateTestStubs } from '@tests/unit/app/composables/installNuxtStateTestStubs';
import { usePlatformHydratedState } from '@app/composables/usePlatformHydratedState';

const cookieStore = new Map<string, Ref<unknown>>();
const stateStore = new Map<string, Ref<unknown>>();

function createDeferred<T>() {
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

describe('usePlatformHydratedState', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        cookieStore.clear();
        stateStore.clear();
        installNuxtStateTestStubs(cookieStore, stateStore);
    });

    it('hydrates a second consumer when the first consumer unmounts mid-load', async () => {
        const deferred = createDeferred<string>();
        const loadValue = vi.fn(() => deferred.promise);
        const onLoaded = vi.fn();
        let firstState!: ReturnType<typeof usePlatformHydratedState<string>>;
        let secondState!: ReturnType<typeof usePlatformHydratedState<string>>;
        const firstScope = effectScope();
        const secondScope = effectScope();

        firstScope.run(() => {
            firstState = usePlatformHydratedState({
                key: 'shared-hydration-test',
                initialValue: () => 'initial',
                initialResolved: false,
                loadValue,
            });
        });
        const firstLoad = firstState.load();
        await vi.waitFor(() => expect(loadValue).toHaveBeenCalledTimes(1));

        secondScope.run(() => {
            secondState = usePlatformHydratedState({
                key: 'shared-hydration-test',
                initialValue: () => 'initial',
                initialResolved: false,
                loadValue,
                onLoaded,
            });
        });
        const secondLoad = secondState.load();
        firstScope.stop();
        deferred.resolve('loaded');

        await expect(firstLoad).resolves.toBeNull();
        await expect(secondLoad).resolves.toBe('loaded');
        expect(secondState.state.value).toBe('loaded');
        expect(secondState.isResolved.value).toBe(true);
        expect(onLoaded).toHaveBeenCalledWith('loaded');
        expect(loadValue).toHaveBeenCalledTimes(1);

        secondScope.stop();
    });
});
