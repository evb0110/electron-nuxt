<template>
    <div class="flex flex-col gap-4">
        <SettingsGeneralPanel
            :settings="settings"
            :locale-items="localeItems"
            :selected-flag-icon="selectedFlagIcon"
            @update:author-name="updateSetting('authorName', $event)"
            @update:theme="applyTheme"
            @update:locale="applyLocale"
            @update:ui-scale="updateSetting('uiScale', $event)"
        />

        <SettingsViewerDefaultsPanel
            :settings="settings"
            :zoom-preset-items="zoomPresetItems"
            :view-mode-items="viewModeItems"
            :scroll-mode-items="scrollModeItems"
            :tab-memory-policy-items="tabMemoryPolicyItems"
            :annotation-color-swatches="annotationColorSwatches"
            @update:zoom-preset="applyZoomPreset"
            @update:view-mode="applyViewMode"
            @update:scroll-mode="applyScrollMode"
            @update:tab-memory-policy="applyTabMemoryPolicy"
            @update:annotation-color="updateSetting('defaultAnnotationColor', $event)"
        />

        <SettingsAgentPanel
            v-if="isDesktopRuntime"
            :assistant-panel-enabled="settings.assistantPanelEnabled"
            :status="agentMcpStatus"
            :is-busy="isAgentMcpBusy"
            @update:assistant-panel-enabled="updateSetting('assistantPanelEnabled', $event)"
            @set-enabled="setAgentMcpEnabled"
            @refresh="refreshAgentMcpStatus"
            @open-install="openAgentMcpInstall"
        />

        <SettingsShortcutsPanel
            :description="shortcutsDescription"
            :items="shortcutItems"
        />

        <SettingsUpdatesPanel
            v-if="isUpdateSupported"
            :is-check-in-progress="isCheckInProgress"
            @check="handleCheckForUpdates"
        />
    </div>
</template>

<script setup lang="ts">
import type {
    TAppLocale,
    TAppTheme,
    TDefaultZoomPreset,
    TTabMemoryPolicy,
    TPdfViewMode,
} from '@contracts/shared';
import type { IAgentMcpIntegrationStatus } from '@contracts/agent';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { getPlatformAPI } from '@app/utils/platform';
import SettingsAgentPanel from '@app/components/settings/SettingsAgentPanel.vue';
import SettingsGeneralPanel from '@app/components/settings/SettingsGeneralPanel.vue';
import SettingsShortcutsPanel from '@app/components/settings/SettingsShortcutsPanel.vue';
import SettingsUpdatesPanel from '@app/components/settings/SettingsUpdatesPanel.vue';
import SettingsViewerDefaultsPanel from '@app/components/settings/SettingsViewerDefaultsPanel.vue';

const { isDesktopRuntime } = useRuntimeEnvironment();
const LOCALE_OPTION_DEFINITIONS = [
    {
        value: 'en',
        icon: 'i-circle-flags-gb',
        labelKey: 'settings.languageEnglish',
    },
    {
        value: 'ru',
        icon: 'i-circle-flags-ru',
        labelKey: 'settings.languageRussian',
    },
    {
        value: 'fr',
        icon: 'i-circle-flags-fr',
        labelKey: 'settings.languageFrench',
    },
    {
        value: 'de',
        icon: 'i-circle-flags-de',
        labelKey: 'settings.languageGerman',
    },
    {
        value: 'es',
        icon: 'i-circle-flags-es',
        labelKey: 'settings.languageSpanish',
    },
    {
        value: 'it',
        icon: 'i-circle-flags-it',
        labelKey: 'settings.languageItalian',
    },
    {
        value: 'pt',
        icon: 'i-circle-flags-pt',
        labelKey: 'settings.languagePortuguese',
    },
    {
        value: 'nl',
        icon: 'i-circle-flags-nl',
        labelKey: 'settings.languageDutch',
    },
] as const satisfies ReadonlyArray<{
    value: TAppLocale;
    icon: string;
    labelKey: string;
}>;
const ZOOM_PRESET_OPTION_DEFINITIONS = [
    {
        value: 'fit-width',
        labelKey: 'zoom.fitWidth',
        label: null,
    },
    {
        value: 'fit-height',
        labelKey: 'zoom.fitHeight',
        label: null,
    },
    {
        value: '100',
        labelKey: null,
        label: '100%',
    },
    {
        value: '125',
        labelKey: null,
        label: '125%',
    },
    {
        value: '150',
        labelKey: null,
        label: '150%',
    },
] as const satisfies ReadonlyArray<{
    value: TDefaultZoomPreset;
    labelKey: string | null;
    label: string | null;
}>;
const VIEW_MODE_OPTION_DEFINITIONS = [
    {
        value: 'single',
        labelKey: 'zoom.singlePage',
    },
    {
        value: 'facing',
        labelKey: 'zoom.facingPages',
    },
    {
        value: 'facing-first-single',
        labelKey: 'zoom.facingWithFirstSingle',
    },
] as const satisfies ReadonlyArray<{
    value: TPdfViewMode;
    labelKey: string;
}>;
const TAB_MEMORY_POLICY_OPTION_DEFINITIONS = [
    {
        value: 'conservative',
        labelKey: 'settings.tabMemoryConservative',
    },
    {
        value: 'aggressive',
        labelKey: 'settings.tabMemoryAggressive',
    },
] as const satisfies ReadonlyArray<{
    value: TTabMemoryPolicy;
    labelKey: string;
}>;
const SUPPORTED_LOCALES: ReadonlySet<string> = new Set<TAppLocale>(LOCALE_OPTION_DEFINITIONS.map(option => option.value));
const DEFAULT_ZOOM_PRESETS: ReadonlySet<string> = new Set<TDefaultZoomPreset>(ZOOM_PRESET_OPTION_DEFINITIONS.map(option => option.value));
const DEFAULT_VIEW_MODES: ReadonlySet<string> = new Set<TPdfViewMode>(VIEW_MODE_OPTION_DEFINITIONS.map(option => option.value));
const TAB_MEMORY_POLICIES: ReadonlySet<string> = new Set<TTabMemoryPolicy>(TAB_MEMORY_POLICY_OPTION_DEFINITIONS.map(option => option.value));

const {
    t,
    setLocale,
} = useTypedI18n();
const colorMode = useColorMode();
const {
    settings,
    load,
    updateSetting,
} = useSettings();
const {
    checkForUpdates,
    ensureInitialized: ensureUpdatesInitialized,
    isCheckInProgress,
    isUpdateSupported,
} = useAppUpdates();

const LOCALE_FLAGS: Record<TAppLocale, string> = Object.fromEntries(
    LOCALE_OPTION_DEFINITIONS.map(option => [
        option.value,
        option.icon,
    ]),
) as Record<TAppLocale, string>;

const selectedFlagIcon = computed(() => LOCALE_FLAGS[settings.value.locale] ?? LOCALE_FLAGS.en);
const annotationColorSwatches = ANNOTATION_COLOR_SWATCHES;
const agentMcpStatus = ref<IAgentMcpIntegrationStatus | null>(null);
const isAgentMcpBusy = ref(false);
const shortcutsDescription = computed(() => isDesktopRuntime.value
    ? t('settings.shortcutsDescription')
    : t('settings.browserShortcutsDescription'));

const localeItems = computed(() => LOCALE_OPTION_DEFINITIONS.map(option => ({
    label: t(option.labelKey),
    value: option.value,
    icon: option.icon,
})));

const zoomPresetItems = computed<Array<{
    value: TDefaultZoomPreset;
    label: string;
}>>(() => ZOOM_PRESET_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: option.labelKey ? t(option.labelKey) : option.label ?? '',
})));

const viewModeItems = computed<Array<{
    value: TPdfViewMode;
    label: string;
}>>(() => VIEW_MODE_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
})));

const scrollModeItems = computed(() => [
    {
        value: true,
        label: t('settings.scrollContinuous'),
    },
    {
        value: false,
        label: t('settings.scrollPageByPage'),
    },
]);

const tabMemoryPolicyItems = computed<Array<{
    value: TTabMemoryPolicy;
    label: string;
}>>(() => TAB_MEMORY_POLICY_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: t(option.labelKey),
})));

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);
const mod = isMac ? '\u2318' : 'Ctrl';
const shift = isMac ? '\u21E7' : 'Shift';

const shortcutItems = computed(() => {
    const browserItems = [
        {
            label: t('toolbar.save'),
            keys: [
                mod,
                'S',
            ],
        },
        {
            label: t('searchResults.enterSearchTerm'),
            keys: [
                mod,
                'F',
            ],
        },
        {
            label: t('zoom.zoomIn'),
            keys: [
                mod,
                '=',
            ],
        },
        {
            label: t('zoom.zoomOut'),
            keys: [
                mod,
                '\u2212',
            ],
        },
        {
            label: t('settings.actualSize'),
            keys: [
                mod,
                '0',
            ],
        },
    ];

    if (!isDesktopRuntime.value) {
        return browserItems;
    }

    return [
        {
            label: t('toolbar.openPdf'),
            keys: [
                mod,
                'O',
            ],
        },
        ...browserItems,
        {
            label: t('toolbar.saveAs'),
            keys: [
                mod,
                shift,
                'S',
            ],
        },
        {
            label: t('zoom.fitWidth'),
            keys: [
                mod,
                '1',
            ],
        },
        {
            label: t('zoom.fitHeight'),
            keys: [
                mod,
                '2',
            ],
        },
    ];
});

function applyTheme(theme: TAppTheme) {
    colorMode.preference = theme;
    updateSetting('theme', theme);
}

function readSelectValue(payload: string | { value: string }) {
    return typeof payload === 'string' ? payload : payload.value;
}

function isDefaultZoomPreset(value: string): value is TDefaultZoomPreset {
    return DEFAULT_ZOOM_PRESETS.has(value);
}

function isPdfViewMode(value: string): value is TPdfViewMode {
    return DEFAULT_VIEW_MODES.has(value);
}

function isAppLocale(value: string): value is TAppLocale {
    return SUPPORTED_LOCALES.has(value);
}

function isTabMemoryPolicy(value: string): value is TTabMemoryPolicy {
    return TAB_MEMORY_POLICIES.has(value);
}

function applyZoomPreset(preset: string | { value: string }) {
    const value = readSelectValue(preset);
    if (isDefaultZoomPreset(value)) {
        updateSetting('defaultZoomPreset', value);
    }
}

function applyViewMode(mode: string | { value: string }) {
    const value = readSelectValue(mode);
    if (isPdfViewMode(value)) {
        updateSetting('defaultViewMode', value);
    }
}

function applyScrollMode(mode: boolean | { value: boolean }) {
    const value = typeof mode === 'boolean' ? mode : mode.value;
    updateSetting('defaultContinuousScroll', value);
}

function applyTabMemoryPolicy(policy: string | { value: string }) {
    const value = readSelectValue(policy);
    if (isTabMemoryPolicy(value)) {
        updateSetting('tabMemoryPolicy', value);
    }
}

async function applyLocale(locale: string | { value: string }) {
    const code = readSelectValue(locale);
    if (isAppLocale(code)) {
        await setLocale(code);
        updateSetting('locale', code);
    }
}

function handleCheckForUpdates() {
    void checkForUpdates();
}

async function refreshAgentMcpStatus() {
    if (!isDesktopRuntime.value || isAgentMcpBusy.value) {
        return;
    }

    isAgentMcpBusy.value = true;
    try {
        agentMcpStatus.value = await getPlatformAPI().agent.getMcpIntegrationStatus();
    } finally {
        isAgentMcpBusy.value = false;
    }
}

async function setAgentMcpEnabled(enabled: boolean) {
    if (!isDesktopRuntime.value || isAgentMcpBusy.value) {
        return;
    }

    isAgentMcpBusy.value = true;
    try {
        const result = await getPlatformAPI().agent.setMcpIntegrationEnabled(enabled);
        agentMcpStatus.value = result.status;
        await load();
    } finally {
        isAgentMcpBusy.value = false;
    }
}

function openAgentMcpInstall() {
    const installUrl = agentMcpStatus.value?.installUrl ?? 'https://developers.openai.com/codex/app';
    void getPlatformAPI().shell.openExternal(installUrl);
}

onMounted(() => {
    void ensureUpdatesInitialized();
    void refreshAgentMcpStatus();
});
</script>
