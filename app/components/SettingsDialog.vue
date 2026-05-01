<template>
    <UModal
        v-model:open="open"
        :title="t('settings.title')"
        :ui="{ footer: 'justify-end' }"
    >
        <template #description>
            <span class="sr-only">
                {{ settingsDialogDescription }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <SettingsGeneralPanel
                    :settings="settings"
                    :locale-items="localeItems"
                    :selected-flag-icon="selectedFlagIcon"
                    @update:author-name="updateSetting('authorName', $event)"
                    @update:theme="applyTheme"
                    @update:locale="applyLocale"
                />

                <SettingsViewerDefaultsPanel
                    :settings="settings"
                    :zoom-preset-items="zoomPresetItems"
                    :view-mode-items="viewModeItems"
                    :scroll-mode-items="scrollModeItems"
                    :annotation-color-swatches="annotationColorSwatches"
                    @update:zoom-preset="applyZoomPreset"
                    @update:view-mode="applyViewMode"
                    @update:scroll-mode="applyScrollMode"
                    @update:annotation-color="updateSetting('defaultAnnotationColor', $event)"
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

        <template #footer="{ close }">
            <UButton
                :label="t('settings.close')"
                color="neutral"
                variant="outline"
                @click="close"
            />
        </template>
    </UModal>
</template>

<script setup lang="ts">
import type {
    TAppLocale,
    TAppTheme,
    TDefaultZoomPreset,
    TPdfViewMode,
} from '@contracts/shared';
import { ANNOTATION_COLOR_SWATCHES } from '@app/constants/pdf-colors';
import SettingsGeneralPanel from '@app/components/settings/SettingsGeneralPanel.vue';
import SettingsShortcutsPanel from '@app/components/settings/SettingsShortcutsPanel.vue';
import SettingsUpdatesPanel from '@app/components/settings/SettingsUpdatesPanel.vue';
import SettingsViewerDefaultsPanel from '@app/components/settings/SettingsViewerDefaultsPanel.vue';

const open = defineModel<boolean>('open', { required: true });
const { isDesktopRuntime } = useRuntimeEnvironment();

const {
    t,
    setLocale,
} = useTypedI18n();
const colorMode = useColorMode();
const {
    settings,
    updateSetting,
} = useSettings();
const {
    checkForUpdates,
    ensureInitialized: ensureUpdatesInitialized,
    isCheckInProgress,
    isUpdateSupported,
} = useAppUpdates();

const LOCALE_FLAGS: Record<string, string> = {
    en: 'i-circle-flags-gb',
    ru: 'i-circle-flags-ru',
    fr: 'i-circle-flags-fr',
    de: 'i-circle-flags-de',
    es: 'i-circle-flags-es',
    it: 'i-circle-flags-it',
    pt: 'i-circle-flags-pt',
    nl: 'i-circle-flags-nl',
};

const selectedFlagIcon = computed(() => LOCALE_FLAGS[settings.value.locale] ?? LOCALE_FLAGS.en!);
const annotationColorSwatches = ANNOTATION_COLOR_SWATCHES;
const settingsDialogDescription = computed(() => isDesktopRuntime
    ? t('settings.dialogDescription')
    : t('settings.browserDialogDescription'));
const shortcutsDescription = computed(() => isDesktopRuntime
    ? t('settings.shortcutsDescription')
    : t('settings.browserShortcutsDescription'));

const localeItems = computed(() => [
    {
        label: t('settings.languageEnglish'),
        value: 'en',
        icon: LOCALE_FLAGS.en!,
    },
    {
        label: t('settings.languageRussian'),
        value: 'ru',
        icon: LOCALE_FLAGS.ru!,
    },
    {
        label: t('settings.languageFrench'),
        value: 'fr',
        icon: LOCALE_FLAGS.fr!,
    },
    {
        label: t('settings.languageGerman'),
        value: 'de',
        icon: LOCALE_FLAGS.de!,
    },
    {
        label: t('settings.languageSpanish'),
        value: 'es',
        icon: LOCALE_FLAGS.es!,
    },
    {
        label: t('settings.languageItalian'),
        value: 'it',
        icon: LOCALE_FLAGS.it!,
    },
    {
        label: t('settings.languagePortuguese'),
        value: 'pt',
        icon: LOCALE_FLAGS.pt!,
    },
    {
        label: t('settings.languageDutch'),
        value: 'nl',
        icon: LOCALE_FLAGS.nl!,
    },
]);

const zoomPresetItems = computed<Array<{
    value: TDefaultZoomPreset;
    label: string;
}>>(() => [
    {
        value: 'fit-width',
        label: t('zoom.fitWidth'),
    },
    {
        value: 'fit-height',
        label: t('zoom.fitHeight'),
    },
    {
        value: '100',
        label: '100%',
    },
    {
        value: '125',
        label: '125%',
    },
    {
        value: '150',
        label: '150%',
    },
]);

const viewModeItems = computed<Array<{
    value: TPdfViewMode;
    label: string;
}>>(() => [
    {
        value: 'single',
        label: t('zoom.singlePage'),
    },
    {
        value: 'facing',
        label: t('zoom.facingPages'),
    },
    {
        value: 'facing-first-single',
        label: t('zoom.facingWithFirstSingle'),
    },
]);

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

    if (!isDesktopRuntime) {
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

function applyZoomPreset(preset: string | { value: string }) {
    const value = (typeof preset === 'string' ? preset : preset.value) as TDefaultZoomPreset;
    updateSetting('defaultZoomPreset', value);
}

function applyViewMode(mode: string | { value: string }) {
    const value = (typeof mode === 'string' ? mode : mode.value) as TPdfViewMode;
    updateSetting('defaultViewMode', value);
}

function applyScrollMode(mode: boolean | { value: boolean }) {
    const value = typeof mode === 'boolean' ? mode : mode.value;
    updateSetting('defaultContinuousScroll', value);
}

async function applyLocale(locale: string | { value: string }) {
    const code = (typeof locale === 'string' ? locale : locale.value) as TAppLocale;
    await setLocale(code);
    updateSetting('locale', code);
}

function handleCheckForUpdates() {
    void checkForUpdates();
}

onMounted(() => {
    void ensureUpdatesInitialized();
});
</script>
