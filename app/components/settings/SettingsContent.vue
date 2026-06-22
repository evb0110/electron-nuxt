<template>
    <div class="settings-grid">
        <section class="settings-card">
            <SettingsGeneralPanel
                :settings="settings"
                :locale-items="localeItems"
                :selected-flag-icon="selectedFlagIcon"
                @update:author-name="updateSetting('authorName', $event)"
                @update:theme="applyTheme"
                @update:locale="applyLocale"
                @update:ui-scale="updateSetting('uiScale', $event)"
            />
        </section>

        <section class="settings-card">
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
                @update:optimize-pdf-on-save-as="updateSetting('optimizePdfOnSaveAs', $event)"
            />
        </section>

        <section v-if="isDesktopRuntime" class="settings-card settings-card--span">
            <SettingsAgentPanel
                :assistant-panel-enabled="settings.assistantPanelEnabled"
                :assistant-state="assistantState"
                :assistant-device-code="assistantDeviceCode"
                :is-assistant-busy="isAssistantBusy"
                :status="agentMcpStatus"
                :is-busy="isAgentMcpBusy"
                @update:assistant-panel-enabled="updateAssistantPanelEnabled"
                @refresh-assistant="refreshAssistantState"
                @install-assistant="installAssistantCodex"
                @start-assistant-login="startAssistantLogin"
                @cancel-assistant-login="cancelAssistantLogin"
                @set-enabled="setAgentMcpEnabled"
                @refresh="refreshAgentMcpStatus"
                @open-install="openAgentMcpInstall"
            />
        </section>

        <section class="settings-card">
            <SettingsShortcutsPanel
                :description="shortcutsDescription"
                :items="shortcutItems"
            />
        </section>

        <section v-if="isUpdateSupported" class="settings-card">
            <SettingsUpdatesPanel
                :is-check-in-progress="isCheckInProgress"
                @check="handleCheckForUpdates"
            />
        </section>
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
import type {
    IAgentAssistantEvent,
    IAgentAssistantState,
    IAgentMcpIntegrationStatus,
} from '@contracts/agent';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdfColors';
import { getPlatformAPI } from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browserLogger';
import { getErrorMessage } from '@app/utils/error';
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
        value: 'pt-BR',
        icon: 'i-circle-flags-br',
        labelKey: 'settings.languagePortugueseBr',
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
const toast = useToast();
const {
    settings,
    load,
    save,
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
const assistantState = ref<IAgentAssistantState | null>(null);
const assistantDeviceCode = ref('');
const assistantAction = ref<'refresh' | 'install' | 'login' | 'cancel' | null>(null);
const isAssistantBusy = computed(() => assistantAction.value !== null);
let assistantPanelPreferenceSave: Promise<void> | null = null;
let unsubscribeAssistantEvent: (() => void) | null = null;
const shortcutsDescription = computed(() => isDesktopRuntime.value
    ? t('settings.shortcutsDescription')
    : t('settings.browserShortcutsDescription'));

const localeItems = computed(() => LOCALE_OPTION_DEFINITIONS.map(option => ({
    label: t(option.labelKey),
    value: option.value,
    icon: option.icon,
})));

const zoomPresetItems = computed(() => ZOOM_PRESET_OPTION_DEFINITIONS.map(option => ({
    value: option.value,
    label: option.labelKey ? t(option.labelKey) : option.label ?? '',
})));

const viewModeItems = computed(() => VIEW_MODE_OPTION_DEFINITIONS.map(option => ({
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

const tabMemoryPolicyItems = computed(() => TAB_MEMORY_POLICY_OPTION_DEFINITIONS.map(option => ({
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

function applyAssistantState(nextState: IAgentAssistantState) {
    assistantState.value = nextState;
    if (nextState.status.authState !== 'login-pending') {
        assistantDeviceCode.value = '';
    }
}

function handleAssistantEvent(event: IAgentAssistantEvent) {
    if (!settings.value.assistantPanelEnabled) {
        return;
    }
    if (event.state) {
        applyAssistantState(event.state);
    }
}

async function runAssistantAction(
    action: 'refresh' | 'install' | 'login' | 'cancel',
    callback: () => Promise<void>,
) {
    if (!isDesktopRuntime.value || assistantAction.value !== null) {
        return;
    }

    assistantAction.value = action;
    try {
        await callback();
    } finally {
        assistantAction.value = null;
    }
}

async function refreshAssistantState() {
    await runAssistantAction('refresh', async () => {
        applyAssistantState(await getPlatformAPI().agent.getAssistantState());
    });
}

async function installAssistantCodex() {
    await runAssistantAction('install', async () => {
        const result = await getPlatformAPI().agent.installAssistantCodex();
        applyAssistantState(result.state);
    });
}

async function startAssistantLogin() {
    await runAssistantAction('login', async () => {
        const result = await getPlatformAPI().agent.startAssistantLogin({ mode: 'chatgpt' });
        applyAssistantState(result.state);
        assistantDeviceCode.value = result.userCode ?? '';
    });
}

async function cancelAssistantLogin() {
    await runAssistantAction('cancel', async () => {
        applyAssistantState(await getPlatformAPI().agent.cancelAssistantLogin());
        assistantDeviceCode.value = '';
    });
}

async function updateAssistantPanelEnabled(enabled: boolean) {
    updateSetting('assistantPanelEnabled', enabled);
    assistantPanelPreferenceSave = save().finally(() => {
        assistantPanelPreferenceSave = null;
    });
    await assistantPanelPreferenceSave;

    if (enabled) {
        await refreshAssistantState();
        return;
    }

    assistantState.value = null;
    assistantDeviceCode.value = '';
}

async function refreshAgentMcpStatus() {
    if (!isDesktopRuntime.value || isAgentMcpBusy.value) {
        return;
    }

    isAgentMcpBusy.value = true;
    try {
        agentMcpStatus.value = await getPlatformAPI().agent.getMcpIntegrationStatus();
    } catch (error) {
        BrowserLogger.warn('settings', 'Failed to refresh agent MCP integration status', { error });
        toast.add({
            color: 'error',
            title: t('settings.agentMcpStatusError'),
            description: getErrorMessage(error),
        });
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
        if (!result.ok && result.error) {
            toast.add({
                color: 'error',
                title: t('settings.agentMcpStatusError'),
                description: result.error,
            });
        }
    } catch (error) {
        BrowserLogger.warn('settings', 'Failed to update agent MCP integration status', {
            enabled,
            error,
        });
        toast.add({
            color: 'error',
            title: t('settings.agentMcpStatusError'),
            description: getErrorMessage(error),
        });
        try {
            agentMcpStatus.value = await getPlatformAPI().agent.getMcpIntegrationStatus();
        } catch (statusError) {
            BrowserLogger.warn('settings', 'Failed to refresh agent MCP status after update failure', { statusError });
        }
    } finally {
        isAgentMcpBusy.value = false;
    }
}

function openAgentMcpInstall() {
    const installUrl = agentMcpStatus.value?.installUrl ?? 'https://developers.openai.com/codex/app';
    void getPlatformAPI().shell.openExternal(installUrl).catch((error: unknown) => {
        BrowserLogger.warn('settings', 'Failed to open agent MCP install URL', {
            installUrl,
            error,
        });
        toast.add({
            color: 'error',
            title: t('settings.agentMcpStatusError'),
            description: getErrorMessage(error),
        });
    });
}

onMounted(() => {
    void ensureUpdatesInitialized();
    void refreshAgentMcpStatus();
    if (isDesktopRuntime.value) {
        unsubscribeAssistantEvent = getPlatformAPI().agent.onAssistantEvent(handleAssistantEvent);
        if (settings.value.assistantPanelEnabled) {
            void refreshAssistantState();
        }
    }
});

watch(() => settings.value.assistantPanelEnabled, (enabled) => {
    if (!isDesktopRuntime.value || assistantPanelPreferenceSave) {
        return;
    }
    if (enabled) {
        if (assistantState.value === null) {
            void refreshAssistantState();
        }
        return;
    }
    assistantState.value = null;
    assistantDeviceCode.value = '';
});

onBeforeUnmount(() => {
    unsubscribeAssistantEvent?.();
    unsubscribeAssistantEvent = null;
});
</script>

<style scoped>
.settings-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--app-space-12xl);
    align-items: start;
}

.settings-card {
    display: flex;
    flex-direction: column;
    gap: var(--app-space-10xl);
    min-width: 0;
    padding: var(--app-space-15xl);
    border: 1px solid var(--app-start-card-border);
    border-radius: var(--app-radius-surface);
    background: var(--app-start-card-bg);
}

.settings-card :deep(.settings-section) {
    min-inline-size: 0;
}

.settings-card--span {
    grid-column: 1 / -1;
}

@container (max-width: 720px) {
    .settings-grid {
        grid-template-columns: minmax(0, 1fr);
    }
}
</style>
