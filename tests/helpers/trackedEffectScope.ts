import { effectScope } from 'vue';

const activeScopes = new Set<ReturnType<typeof effectScope>>();

/**
 * Builds a composable inside an effect scope the test can dispose.
 *
 * A composable called straight from a test has no scope, so the timers and
 * listeners it releases on teardown are never released: a pending one outlives
 * the file and fires against an environment that is gone, which vitest reports
 * as an unhandled error against whichever file was unlucky enough to be running.
 * Build it through here and call `stopTrackedScopes()` in `afterEach` to get the
 * teardown the app gets when its component unmounts.
 */
export function runInTrackedScope<T>(build: () => T): T {
    const scope = effectScope();
    activeScopes.add(scope);
    const built = scope.run(build);
    if (built === undefined) {
        throw new Error('The tracked effect scope stopped before its composable was built.');
    }
    return built;
}

export function stopTrackedScopes() {
    for (const scope of activeScopes) {
        scope.stop();
    }
    activeScopes.clear();
}
