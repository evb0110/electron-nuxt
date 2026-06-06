import type { IHostEnvironmentSnapshot } from '@contracts/electronApiHost';
import type { TUiScalePreference } from '@contracts/shared';
import { clamp } from 'es-toolkit/math';

const PRESET_SCALE_FACTORS: Record<Exclude<TUiScalePreference, 'auto'>, number> = {
    compact: 0.9,
    default: 1,
    comfortable: 1.1,
    large: 1.25,
};

const WINDOWS_AUTO_COMPENSATION_T = 0.4;
const MIN_AUTO_SCALE = 0.85;
const MAX_AUTO_SCALE = 1;

function lerp(start: number, end: number, t: number) {
    return start + (end - start) * t;
}

function resolveAutoScale(snapshot: IHostEnvironmentSnapshot) {
    if (snapshot.platform !== 'win32') {
        return 1;
    }
    if (!Number.isFinite(snapshot.osScaleFactor) || snapshot.osScaleFactor <= 1) {
        return 1;
    }
    const compensated = lerp(1, 1 / snapshot.osScaleFactor, WINDOWS_AUTO_COMPENSATION_T);
    return clamp(compensated, MIN_AUTO_SCALE, MAX_AUTO_SCALE);
}

export function resolveEffectiveUiScale(
    preference: TUiScalePreference,
    snapshot: IHostEnvironmentSnapshot,
) {
    if (preference === 'auto') {
        return resolveAutoScale(snapshot);
    }
    return PRESET_SCALE_FACTORS[preference] ?? 1;
}
