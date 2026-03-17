import type {
    TDocumentRef,
    TOpenFileResult,
} from '@contracts/platform-api';

type TWorkspaceLaunchIntent =
    | {
        kind: 'open-result';
        result: TOpenFileResult;
    }
    | {
        kind: 'open-path';
        path: TDocumentRef;
    };

export function useWorkspaceLaunchIntent() {
    const launchIntent = useState<TWorkspaceLaunchIntent | null>('workspace-launch-intent', () => null);

    function queueOpenResult(result: TOpenFileResult) {
        launchIntent.value = {
            kind: 'open-result',
            result,
        };
    }

    function queueOpenPath(path: TDocumentRef) {
        launchIntent.value = {
            kind: 'open-path',
            path,
        };
    }

    function consumeLaunchIntent() {
        const nextIntent = launchIntent.value;
        launchIntent.value = null;
        return nextIntent;
    }

    function clearLaunchIntent() {
        launchIntent.value = null;
    }

    return {
        launchIntent: readonly(launchIntent),
        queueOpenResult,
        queueOpenPath,
        consumeLaunchIntent,
        clearLaunchIntent,
    };
}
