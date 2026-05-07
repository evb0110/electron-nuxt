<template>
    <UApp>
        <NuxtPage />
        <div
            v-if="fatalRuntimeError"
            class="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--app-window-bg)]/96 p-6 backdrop-blur-sm"
        >
            <div class="w-full max-w-xl rounded-2xl border border-[color:var(--ui-border)] bg-[color:var(--ui-bg)] p-6 shadow-[var(--shadow-popup)]">
                <UAlert
                    color="error"
                    variant="soft"
                    icon="i-lucide-triangle-alert"
                    :title="fatalRuntimeTitle"
                    :description="fatalRuntimeDescription"
                />
                <div
                    v-if="fatalRuntimeError.detail"
                    class="mt-4 rounded-xl border border-[color:var(--ui-border)] bg-[color:var(--ui-bg-elevated)] p-4 text-sm text-[color:var(--ui-text-dimmed)]"
                >
                    <p class="font-medium text-[color:var(--ui-text)]">
                        {{ t('errors.runtime.details') }}
                    </p>
                    <p class="mt-2 break-words">
                        {{ fatalRuntimeError.detail }}
                    </p>
                </div>
                <div class="mt-5 flex flex-wrap gap-3">
                    <UButton
                        color="error"
                        icon="i-lucide-refresh-cw"
                        @click="reloadAfterFatalRuntimeError"
                    >
                        {{ t('errors.runtime.reload') }}
                    </UButton>
                    <UButton
                        v-if="fatalRuntimeError.detail"
                        color="neutral"
                        variant="soft"
                        icon="i-lucide-copy"
                        @click="copyText(fatalRuntimeError.detail)"
                    >
                        {{ t('errors.runtime.copy') }}
                    </UButton>
                </div>
            </div>
        </div>
        <div
            v-if="runtimeErrorReports.length > 0"
            class="fixed bottom-4 right-4 z-40 w-[min(32rem,calc(100vw-2rem))]"
        >
            <div
                class="rounded-lg border border-[color:var(--ui-border)] bg-[color:var(--ui-bg)] p-4 shadow-[var(--shadow-popup)]"
            >
                <div class="flex items-start gap-3">
                    <UIcon name="i-lucide-circle-x" class="mt-0.5 size-5 shrink-0 text-[color:var(--ui-error)]" />
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                            <p class="truncate text-sm font-medium text-[color:var(--ui-text)]">
                                {{ t('errors.runtime.reportReady') }}
                            </p>
                            <UBadge
                                color="error"
                                variant="soft"
                                size="sm"
                            >
                                {{ runtimeErrorReportCount }}
                            </UBadge>
                        </div>
                        <p class="mt-1 text-xs text-[color:var(--ui-text-dimmed)]">
                            {{ t('errors.runtime.reportDescription') }}
                        </p>
                        <div
                            v-if="showRuntimeErrorDetails"
                            class="mt-3 space-y-3"
                        >
                            <div
                                v-for="report in runtimeErrorReports"
                                :key="report.id"
                                class="rounded-md bg-[color:var(--ui-bg-elevated)] p-3"
                            >
                                <div class="flex items-center gap-2">
                                    <p class="truncate text-xs font-medium text-[color:var(--ui-text)]">
                                        {{ report.title }}
                                    </p>
                                    <UBadge
                                        v-if="report.count > 1"
                                        color="error"
                                        variant="soft"
                                        size="sm"
                                    >
                                        {{ report.count }}
                                    </UBadge>
                                </div>
                                <p class="mt-1 text-xs text-[color:var(--ui-text-dimmed)]">
                                    {{ report.source }}
                                </p>
                                <pre class="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-[color:var(--ui-text-muted)]">{{ report.detail }}</pre>
                            </div>
                        </div>
                    </div>
                    <div class="flex shrink-0 gap-1">
                        <UTooltip :text="t('errors.runtime.copy')" :delay-duration="400">
                            <UButton
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                icon="i-lucide-copy"
                                :aria-label="t('errors.runtime.copy')"
                                @click="copyText(formatRuntimeErrorReports())"
                            />
                        </UTooltip>
                        <UTooltip :text="t('errors.runtime.details')" :delay-duration="400">
                            <UButton
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                :icon="showRuntimeErrorDetails ? 'i-lucide-chevron-down' : 'i-lucide-chevron-up'"
                                :aria-label="t('errors.runtime.details')"
                                @click="showRuntimeErrorDetails = !showRuntimeErrorDetails"
                            />
                        </UTooltip>
                        <UTooltip :text="t('errors.runtime.dismiss')" :delay-duration="400">
                            <UButton
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                icon="i-lucide-x"
                                :aria-label="t('errors.runtime.dismiss')"
                                @click="clearRuntimeErrorReports"
                            />
                        </UTooltip>
                    </div>
                </div>
            </div>
        </div>
        <DevOnly>
            <ClientOnly>
                <AgentationWidget />
            </ClientOnly>
        </DevOnly>
    </UApp>
</template>

<script setup lang="ts">
import AgentationWidget from '@app/components/AgentationWidget.vue';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_THEME_COOKIE_KEY,
} from '@app/utils/browser-settings-persistence';
import { waitForVisualFrames } from '@app/utils/async-helpers';

const {
    load: loadSettings,
    settings,
} = useSettings();
const {
    loadRecentFiles,
    syncCookieFromRuntime: syncRecentFilesCookieFromRuntime,
} = useRecentFiles();
const {
    isBrowserRuntime,
    isDesktopRuntime,
} = useRuntimeEnvironment();
const {
    locale,
    t,
    setLocale,
} = useTypedI18n();
const {
    fatalRuntimeError,
    setFatalRuntimeError,
    clearFatalRuntimeError,
    reloadAfterFatalRuntimeError,
} = useFatalRuntimeError();
const {
    reports: runtimeErrorReports,
    clearRuntimeErrorReports,
} = useRuntimeErrorReports();
const showRuntimeErrorDetails = ref(false);
const route = useRoute();
const colorMode = useColorMode();
const localeHead = useLocaleHead({
    identifierAttribute: 'id',
    addSeoAttributes: true,
} as never);
const localeCookie = useCookie<string | null | undefined>(BROWSER_LOCALE_COOKIE_KEY, { watch: false });
const themeCookie = useCookie<string | null | undefined>(BROWSER_THEME_COOKIE_KEY, { watch: false });
const DEV_RELOAD_EVENT_KEY = 'evb-viewer:dev:last-vite-reload-event';
const fatalRuntimeTitle = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupTitle')
    : t('errors.runtime.title'));
const fatalRuntimeDescription = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupDescription')
    : t('errors.runtime.description'));
const runtimeErrorReportCount = computed(() => runtimeErrorReports.value.reduce(
    (total, report) => total + report.count,
    0,
));

function formatRuntimeErrorReport(report: {
    title: string;
    source: string;
    detail: string;
    count: number;
}) {
    return [
        report.title,
        `${t('errors.runtime.source')}: ${report.source}`,
        `${t('errors.runtime.count')}: ${report.count}`,
        '',
        report.detail,
    ].join('\n');
}

function formatRuntimeErrorReports() {
    return runtimeErrorReports.value.map(formatRuntimeErrorReport).join('\n\n---\n\n');
}

async function copyText(value: string) {
    if (!import.meta.client || !navigator.clipboard) {
        return;
    }
    try {
        await navigator.clipboard.writeText(value);
    } catch (error) {
        BrowserLogger.warn('runtime-errors', 'Failed to copy runtime error report', error);
    }
}

if (localeCookie.value !== settings.value.locale) {
    localeCookie.value = settings.value.locale;
}

if (themeCookie.value !== settings.value.theme) {
    themeCookie.value = settings.value.theme;
}

colorMode.preference = settings.value.theme;

useHead(() => ({
    htmlAttrs: {
        ...localeHead.value.htmlAttrs,
        dir: 'ltr',
        class: [
            localeHead.value.htmlAttrs?.class,
            settings.value.theme,
        ].filter(Boolean).join(' '),
    },
    meta: localeHead.value.meta,
    link: localeHead.value.link,
}));

async function preloadStartupContent() {
    if (!import.meta.client) {
        return;
    }

    const warmupStartedAt = performance.now();
    BrowserLogger.debug('loader', 'Startup content warmup started', { isDesktopRuntime: isDesktopRuntime.value });

    const warmupTasks: Array<Promise<unknown>> = [loadRecentFiles()];
    if (route.meta.preloadWorkspaceShell !== false) {
        warmupTasks.unshift(import('@app/modules/workspace-shell/components/DocumentWorkspace.vue'));
    }

    const results = await Promise.allSettled(warmupTasks);
    BrowserLogger.debug('loader', 'Startup content warmup settled', {
        durationMs: Math.round(performance.now() - warmupStartedAt),
        taskStates: results.map(result => result.status),
    });
}

function installViteReloadDiagnostics() {
    if (!import.meta.dev || typeof window === 'undefined') {
        return;
    }

    try {
        const rawPreviousEvent = window.sessionStorage.getItem(DEV_RELOAD_EVENT_KEY);
        if (rawPreviousEvent) {
            const previousEvent: unknown = JSON.parse(rawPreviousEvent);
            BrowserLogger.debug('dev-reload', 'Previous Vite reload event (persisted)', previousEvent);
            window.sessionStorage.removeItem(DEV_RELOAD_EVENT_KEY);
        }
    } catch {
        // sessionStorage may be unavailable or contain invalid JSON
    }

    const hot = (import.meta as ImportMeta & {hot?: {on?: (event: string, callback: (payload: unknown) => void) => void;};}).hot;

    if (typeof hot?.on !== 'function') {
        return;
    }

    hot.on('vite:beforeFullReload', (payload: unknown) => {
        const event = {
            timestamp: Date.now(),
            event: 'vite:beforeFullReload',
            payload,
        };

        BrowserLogger.debug('dev-reload', 'Vite announced full reload', event);
        try {
            window.sessionStorage.setItem(DEV_RELOAD_EVENT_KEY, JSON.stringify(event));
        } catch {
            // sessionStorage may be unavailable
        }
    });

    hot.on('vite:error', (payload: unknown) => {
        BrowserLogger.error('dev-reload', 'Vite HMR error event received', payload);
    });
}

installViteReloadDiagnostics();

onMounted(async () => {
    const mountTime = Date.now();
    try {
        clearFatalRuntimeError();
        await loadSettings();
        localeCookie.value = settings.value.locale;
        themeCookie.value = settings.value.theme;
        if (locale.value !== settings.value.locale) {
            await setLocale(settings.value.locale);
        }
        colorMode.preference = settings.value.theme;

        await preloadStartupContent();
        if (isBrowserRuntime.value) {
            void syncRecentFilesCookieFromRuntime();
        }
        await nextTick();
        await waitForVisualFrames();
    } catch (error) {
        BrowserLogger.error('loader', 'App bootstrap failed', error);
        setFatalRuntimeError('startup', error, 'app-bootstrap');
    } finally {
        // Always emit readiness, even on bootstrap failure, so preload fallbacks
        // can deterministically remove startup overlays and avoid hanging UI.
        if (typeof window !== 'undefined') {
            (window as Window & {
                __appReady?: boolean;
                __appReadyAt?: number
            }).__appReady = true;
            (window as Window & {
                __appReady?: boolean;
                __appReadyAt?: number
            }).__appReadyAt = mountTime;
            window.dispatchEvent(new Event('evb:app-ready'));
        }
    }
});
</script>
