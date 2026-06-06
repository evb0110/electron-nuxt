import type {
    IHostEnvironmentSnapshot,
    THostPlatform,
} from '@contracts/electronApiHost';
import type {
    ISettingsData,
    TUiScalePreference,
} from '@contracts/shared';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getPlatformAPI } from '@app/utils/platform';
import { resolveEffectiveUiScale } from '@app/utils/ui-scale/resolveEffectiveUiScale';

const FALLBACK_PLATFORM: THostPlatform = typeof process !== 'undefined' && process.platform === 'darwin'
    ? 'darwin'
    : 'linux';

const DEFAULT_HOST_SNAPSHOT: IHostEnvironmentSnapshot = {
    platform: FALLBACK_PLATFORM,
    osScaleFactor: 1,
};

function applyUiScaleToDocument(scale: number, snapshot: IHostEnvironmentSnapshot) {
    if (typeof document === 'undefined') {
        return;
    }
    const root = document.documentElement;
    root.style.setProperty('--app-ui-scale', String(scale));
    root.dataset.platform = snapshot.platform;
}

export const useUiScale = () => {
    const hostSnapshot = useState<IHostEnvironmentSnapshot>(
        'host:environment',
        () => DEFAULT_HOST_SNAPSHOT,
    );

    const preference = useState<TUiScalePreference>(
        'ui-scale:preference',
        () => 'auto',
    );

    const effectiveScale = computed(() =>
        resolveEffectiveUiScale(preference.value, hostSnapshot.value),
    );

    function setPreferenceFromSettings(settings: Pick<ISettingsData, 'uiScale'>) {
        preference.value = settings.uiScale;
    }

    function setHostSnapshot(snapshot: IHostEnvironmentSnapshot) {
        hostSnapshot.value = snapshot;
    }

    async function refreshHostSnapshot() {
        try {
            const next = await getPlatformAPI().host.getEnvironment();
            setHostSnapshot(next);
        } catch (error) {
            BrowserLogger.warn('ui-scale', 'Failed to load host environment snapshot', error);
        }
    }

    function attachHostEnvironmentListener() {
        return getPlatformAPI().host.onEnvironmentChange((snapshot) => {
            setHostSnapshot(snapshot);
        });
    }

    return {
        hostSnapshot,
        preference,
        effectiveScale,
        setPreferenceFromSettings,
        setHostSnapshot,
        refreshHostSnapshot,
        attachHostEnvironmentListener,
        applyUiScaleToDocument,
    };
};
