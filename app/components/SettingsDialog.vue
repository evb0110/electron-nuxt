<template>
    <UModal
        v-model:open="open"
        :title="t('settings.title')"
        :ui="{ footer: 'justify-end' }"
    >
        <template #description>
            <span class="sr-only">
                {{ t('settings.dialogDescription') }}
            </span>
        </template>

        <template #body>
            <div class="flex flex-col gap-4">
                <fieldset class="settings-group flex flex-col gap-2.5">
                    <legend class="settings-legend">{{ t('settings.general') }}</legend>

                    <div class="settings-field flex flex-col gap-1">
                        <label class="settings-label" for="settings-author">
                            {{ t('settings.author') }}
                        </label>
                        <UInput
                            id="settings-author"
                            :model-value="settings.authorName"
                            :placeholder="t('settings.authorPlaceholder')"
                            icon="i-lucide-user"
                            @update:model-value="updateSetting('authorName', $event as string)"
                        />
                        <p class="settings-hint">{{ t('settings.authorDescription') }}</p>
                    </div>

                    <div class="settings-field flex flex-col gap-1">
                        <label class="settings-label">{{ t('settings.theme') }}</label>
                        <div class="settings-segmented">
                            <button
                                type="button"
                                class="settings-seg-btn"
                                :class="{ 'is-active': settings.theme === 'light' }"
                                @click="applyTheme('light')"
                            >
                                <UIcon name="i-lucide-sun" class="settings-seg-icon" />
                                {{ t('settings.themeLight') }}
                            </button>
                            <button
                                type="button"
                                class="settings-seg-btn"
                                :class="{ 'is-active': settings.theme === 'dark' }"
                                @click="applyTheme('dark')"
                            >
                                <UIcon name="i-lucide-moon" class="settings-seg-icon" />
                                {{ t('settings.themeDark') }}
                            </button>
                        </div>
                    </div>

                    <div class="settings-field flex flex-col gap-1">
                        <label class="settings-label">{{ t('settings.language') }}</label>
                        <USelectMenu
                            :model-value="settings.locale"
                            :items="localeItems"
                            value-key="value"
                            :icon="selectedFlagIcon"
                            :search-input="false"
                            @update:model-value="applyLocale"
                        />
                    </div>
                </fieldset>

                <fieldset class="settings-group flex flex-col gap-2.5">
                    <legend class="settings-legend">{{ t('settings.viewerDefaults') }}</legend>

                    <div class="settings-field flex flex-col gap-1">
                        <label class="settings-label">{{ t('settings.defaultZoom') }}</label>
                        <USelectMenu
                            :model-value="settings.defaultZoomPreset"
                            :items="zoomPresetItems"
                            value-key="value"
                            :search-input="false"
                            @update:model-value="applyZoomPreset"
                        />
                    </div>

                    <div class="settings-field flex flex-col gap-1">
                        <label class="settings-label">{{ t('settings.defaultViewMode') }}</label>
                        <USelectMenu
                            :model-value="settings.defaultViewMode"
                            :items="viewModeItems"
                            value-key="value"
                            :search-input="false"
                            @update:model-value="applyViewMode"
                        />
                    </div>

                    <div class="settings-field flex flex-col gap-1">
                        <label class="settings-label">{{ t('settings.defaultScrollMode') }}</label>
                        <USelectMenu
                            :model-value="settings.defaultContinuousScroll"
                            :items="scrollModeItems"
                            value-key="value"
                            :search-input="false"
                            @update:model-value="applyScrollMode"
                        />
                    </div>

                    <div class="settings-field flex flex-col gap-1">
                        <label class="settings-label">{{ t('settings.defaultAnnotationColor') }}</label>
                        <div class="flex gap-2">
                            <button
                                v-for="swatch in annotationColorSwatches"
                                :key="swatch"
                                type="button"
                                class="settings-swatch"
                                :class="{ 'is-active': settings.defaultAnnotationColor === swatch }"
                                :style="{ '--swatch-color': swatch }"
                                :aria-label="t('settings.annotationColorLabel', { color: swatch })"
                                @click="updateSetting('defaultAnnotationColor', swatch)"
                            />
                        </div>
                    </div>
                </fieldset>

                <details class="settings-details flex flex-col">
                    <summary class="settings-legend is-toggle">
                        {{ t('settings.shortcuts') }}
                    </summary>
                    <div class="flex flex-col">
                        <div
                            v-for="item in shortcutItems"
                            :key="item.label"
                            class="settings-shortcut-row flex items-center justify-between gap-3"
                        >
                            <span class="settings-shortcut-label">{{ item.label }}</span>
                            <span class="settings-shortcut-keys flex shrink-0">
                                <kbd
                                    v-for="(part, i) in item.keys"
                                    :key="i"
                                    class="settings-kbd"
                                >{{ part }}</kbd>
                            </span>
                        </div>
                    </div>
                </details>

                <fieldset
                    v-if="isUpdateSupported"
                    class="settings-group flex flex-col gap-2.5"
                >
                    <legend class="settings-legend">{{ t('settings.updates') }}</legend>
                    <UButton
                        :label="isCheckInProgress ? t('updates.checkingAction') : t('settings.checkForUpdates')"
                        color="neutral"
                        variant="outline"
                        :loading="isCheckInProgress"
                        :disabled="isCheckInProgress"
                        @click="handleCheckForUpdates"
                    />
                </fieldset>
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

const open = defineModel<boolean>('open', { required: true });

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

const selectedFlagIcon = computed(() => LOCALE_FLAGS[settings.value.locale] ?? LOCALE_FLAGS.en);
const annotationColorSwatches = ANNOTATION_COLOR_SWATCHES;

const localeItems = computed(() => [
    {
        label: t('settings.languageEnglish'),
        value: 'en',
        icon: LOCALE_FLAGS.en,
    },
    {
        label: t('settings.languageRussian'),
        value: 'ru',
        icon: LOCALE_FLAGS.ru,
    },
    {
        label: t('settings.languageFrench'),
        value: 'fr',
        icon: LOCALE_FLAGS.fr,
    },
    {
        label: t('settings.languageGerman'),
        value: 'de',
        icon: LOCALE_FLAGS.de,
    },
    {
        label: t('settings.languageSpanish'),
        value: 'es',
        icon: LOCALE_FLAGS.es,
    },
    {
        label: t('settings.languageItalian'),
        value: 'it',
        icon: LOCALE_FLAGS.it,
    },
    {
        label: t('settings.languagePortuguese'),
        value: 'pt',
        icon: LOCALE_FLAGS.pt,
    },
    {
        label: t('settings.languageDutch'),
        value: 'nl',
        icon: LOCALE_FLAGS.nl,
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

const shortcutItems = computed(() => [
    {
        label: t('toolbar.openPdf'),
        keys: [
            mod,
            'O',
        ],
    },
    {
        label: t('toolbar.save'),
        keys: [
            mod,
            'S',
        ],
    },
    {
        label: t('toolbar.saveAs'),
        keys: [
            mod,
            shift,
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
]);

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

<style lang="scss" scoped>
/* ─── Fieldset groups (no border dividers — spacing only) ─── */

.settings-group {
    border: none;
    padding: 0;
    margin: 0;
}

.settings-legend {
    font-size: 0.6875rem;
    font-weight: 600;
    color: var(--ui-text-dimmed);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0;
    margin-bottom: 0.125rem;
}

/* ─── Collapsible shortcuts ─── */

.settings-details[open] {
    gap: 0.375rem;
}

.settings-legend.is-toggle {
    cursor: pointer;
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.375rem;
}

.settings-legend.is-toggle::-webkit-details-marker {
    display: none;
}

.settings-legend.is-toggle::before {
    content: "";
    display: inline-block;
    width: 0;
    height: 0;
    border-style: solid;
    border-width: 0.3rem 0 0.3rem 0.4rem;
    border-color: transparent transparent transparent var(--ui-text-dimmed);
    transition: transform $ease-standard;
    flex-shrink: 0;
}

.settings-details[open] > .settings-legend.is-toggle::before {
    transform: rotate(90deg);
}

/* ─── Fields ─── */


.settings-label {
    font-size: 0.8125rem;
    font-weight: 500;
    color: var(--ui-text);
}

.settings-hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.35;
    color: var(--ui-text-dimmed);
}

/* ─── Segmented control ─── */

.settings-segmented {
    display: flex;
    border: 1px solid var(--ui-border);
    border-radius: calc(var(--ui-radius) * 1.5);
    overflow: hidden;
    background: color-mix(in oklab, var(--ui-bg-muted) 50%, var(--ui-bg) 50%);
}

.settings-seg-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.3rem;
    border: none;
    background: transparent;
    color: var(--ui-text-muted);
    height: 2.25rem;
    padding: 0 0.75rem;
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: background-color $ease-standard, color $ease-standard, box-shadow $ease-standard;
}

.settings-seg-btn + .settings-seg-btn {
    border-left: 1px solid var(--ui-border);
}

.settings-seg-btn:hover:not(.is-active) {
    color: var(--ui-text);
    background: color-mix(in oklab, var(--ui-bg) 80%, var(--ui-border) 20%);
}

.settings-seg-btn.is-active {
    background: var(--ui-bg);
    color: var(--ui-text);
    font-weight: 600;
    box-shadow:
        0 1px 2px color-mix(in srgb, var(--ui-bg-inverted) 6%, transparent),
        inset 0 -1px 0 color-mix(in srgb, var(--ui-bg-inverted) 4%, transparent);
}

.settings-seg-icon {
    width: 0.875rem;
    height: 0.875rem;
    flex-shrink: 0;
}

/* ─── Color swatches ─── */

.settings-swatch {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: 50%;
    border: 2px solid transparent;
    background: var(--swatch-color);
    cursor: pointer;
    transition: transform $ease-quick, box-shadow $ease-quick;
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-bg-inverted) 12%, transparent);
}

.settings-swatch:hover {
    transform: scale(1.15);
}

.settings-swatch.is-active {
    box-shadow:
        0 0 0 2px var(--ui-bg),
        0 0 0 3.5px var(--ui-primary),
        inset 0 0 0 1px color-mix(in srgb, var(--ui-bg-inverted) 12%, transparent);
}

/* ─── Keyboard shortcuts ─── */

.settings-shortcut-row {
    padding: 0.25rem 0;
}

.settings-shortcut-label {
    font-size: 0.8125rem;
    color: var(--ui-text);
}

.settings-shortcut-keys {
    gap: 0.15rem;
    white-space: nowrap;
}

.settings-kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.25rem;
    height: 1.25rem;
    padding: 0 0.25rem;
    font-family: var(--app-font-mono);
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1;
    color: var(--ui-text-muted);
    background: color-mix(in oklab, var(--ui-bg-muted) 55%, var(--ui-bg) 45%);
    border: 1px solid var(--ui-border);
    border-bottom-width: 2px;
    border-radius: 0.25rem;
}
</style>
