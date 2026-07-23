import type { ISettingsData } from '@contracts/shared';
import type {
    IDebugLogEntry,
    IRendererLogEntry,
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';
import {
    DEFAULT_SETTINGS,
    sanitizeSettings,
} from '@contracts/settings';
import {
    defineForwardedPlatformMethod,
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';
import { isRecord } from '@contracts/runtimeGuards';

type TVoidResult = ReturnType<() => void>;

function decodeSettingsPatch(value: unknown): Partial<ISettingsData> {
    if (!isRecord(value)) {
        throw new Error('settings must be an object');
    }
    const normalized = sanitizeSettings({
        ...DEFAULT_SETTINGS,
        ...value,
    });
    for (const [
        key,
        candidate,
    ] of Object.entries(value)) {
        if (!(key in normalized) || normalized[key as keyof typeof normalized] !== candidate) {
            throw new Error(`invalid settings field: ${key}`);
        }
    }
    return value;
}

function decodeSettingsResult(value: unknown) {
    if (!isRecord(value)) {
        throw new Error('invalid settings result');
    }
    const normalized = sanitizeSettings(value);
    const allowedKeys = new Set(Object.keys(normalized));
    for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
            throw new Error(`invalid settings result field: ${key}`);
        }
    }
    for (const [
        key,
        candidate,
    ] of Object.entries(normalized)) {
        if (value[key] !== candidate) {
            throw new Error(`invalid settings result field: ${key}`);
        }
    }
    return normalized;
}

const settingsPatch = s.fromParser(decodeSettingsPatch, (): Partial<ISettingsData> => ({theme: 'dark'}));
const settingsResult = s.fromParser(decodeSettingsResult, () => DEFAULT_SETTINGS);
const voidResult = s.declared<TVoidResult>()(s.undefined());

export const SETTINGS_PLATFORM_FEATURE = definePlatformFeature({
    path: ['settings'],
    required: {
        browser: true,
        electron: true,
    },
    methods: {
        get: {
            kind: 'async',
            channel: 'settings:get',
            ipc: {
                args: s.tuple([]),
                result: settingsResult,
            },
            main: {
                method: 'get',
                context: 'none',
            },
            browser: {method: 'get'},
            lazy: 'forwarded',
        },
        save: defineForwardedPlatformMethod({
            name: 'save',
            channel: 'settings:save',
            args: s.tuple([settingsPatch]),
            result: voidResult,
            main: 'save',
        }),
    },
    events: {},
});

interface ISettingsSupportCapability {
    getDebugLogs: () => Promise<IDebugLogEntry[]>;
    onDebugLog: (callback: (entry: IDebugLogEntry) => void) => TMenuEventUnsubscribe;
    rendererLog: (entry: IRendererLogEntry) => void;
    onMenuOpenSettings: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
}

export type ISettingsCapability =
    TFeatureCapability<typeof SETTINGS_PLATFORM_FEATURE> & ISettingsSupportCapability;
export type ISettingsInvokeMap = TFeatureInvokeMap<typeof SETTINGS_PLATFORM_FEATURE>;
