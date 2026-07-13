<template>
    <UApp>
        <NuxtPage />
        <div
            v-if="fatalRuntimeError"
            class="fixed inset-0 z-50 flex items-center justify-center bg-[color:var(--app-window-bg)]/96 p-6 backdrop-blur-sm"
        >
            <div class="w-full max-w-xl rounded-2xl border border-default bg-default p-6 shadow-[var(--shadow-popup)]">
                <UAlert
                    color="error"
                    variant="soft"
                    icon="i-ph-warning"
                    :title="fatalRuntimeTitle"
                    :description="fatalRuntimeDescription"
                />
                <div
                    v-if="fatalRuntimeError.detail"
                    class="mt-4 rounded-xl border border-default bg-elevated p-4 text-sm text-dimmed"
                >
                    <p class="font-medium text-default">
                        {{ t('errors.runtime.details') }}
                    </p>
                    <p class="mt-2 break-words">
                        {{ fatalRuntimeError.detail }}
                    </p>
                </div>
                <div class="mt-5 flex flex-wrap gap-3">
                    <UButton
                        color="error"
                        icon="i-ph-arrows-clockwise"
                        @click="reloadAfterFatalRuntimeError"
                    >
                        {{ t('errors.runtime.reload') }}
                    </UButton>
                    <UButton
                        v-if="fatalRuntimeError.detail"
                        color="neutral"
                        variant="soft"
                        :icon="recentlyCopiedFatalDetail ? 'i-ph-check' : 'i-ph-copy'"
                        @click="handleCopyFatalRuntimeDetail"
                    >
                        {{ t('errors.runtime.copy') }}
                    </UButton>
                </div>
            </div>
        </div>
        <div
            v-if="runtimeErrorReports.length > 0"
            class="runtime-error-reports fixed bottom-4 right-4 z-40"
        >
            <div
                class="runtime-error-reports-card overflow-hidden rounded-lg border border-default bg-default p-4 shadow-[var(--shadow-popup)]"
            >
                <div class="flex items-start gap-3">
                    <UIcon name="i-ph-x-circle" class="mt-0.5 size-5 shrink-0 text-[color:var(--ui-error)]" />
                    <div class="min-w-0 flex-1">
                        <div class="flex items-center gap-2">
                            <p class="truncate text-sm font-medium text-default">
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
                        <p class="mt-1 text-xs text-dimmed">
                            {{ t('errors.runtime.reportDescription') }}
                        </p>
                        <div
                            v-if="showRuntimeErrorDetails"
                            class="runtime-error-report-details mt-3 space-y-3 overflow-y-auto pr-1"
                        >
                            <div
                                v-for="report in runtimeErrorReports"
                                :key="report.id"
                                class="rounded-md bg-elevated p-3"
                            >
                                <div class="flex items-center gap-2">
                                    <p class="min-w-0 flex-1 truncate text-xs font-medium text-default">
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
                                    <AppTooltip :text="t('errors.runtime.dismiss')" :delay-duration="400">
                                        <UButton
                                            color="neutral"
                                            variant="ghost"
                                            size="xs"
                                            icon="i-ph-x"
                                            :aria-label="t('errors.runtime.dismiss')"
                                            @click="dismissRuntimeErrorReport(report.id)"
                                        />
                                    </AppTooltip>
                                </div>
                                <p class="mt-1 text-xs text-dimmed">
                                    {{ report.source }}
                                </p>
                                <pre class="mt-2 max-h-24 overflow-auto whitespace-pre-wrap break-words text-xs text-muted">{{ report.detail }}</pre>
                            </div>
                        </div>
                    </div>
                    <div class="flex shrink-0 gap-1">
                        <AppTooltip :text="t('errors.runtime.copy')" :delay-duration="400">
                            <UButton
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                :icon="recentlyCopiedReports ? 'i-ph-check' : 'i-ph-copy'"
                                :class="[
                                    'copy-report-button transition-transform duration-150 ease-out hover:scale-110 active:scale-90',
                                    recentlyCopiedReports && 'copy-report-button--success',
                                ]"
                                :aria-label="t('errors.runtime.copy')"
                                @click="handleCopyReports"
                            />
                        </AppTooltip>
                        <AppTooltip :text="t('errors.runtime.details')" :delay-duration="400">
                            <UButton
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                :icon="showRuntimeErrorDetails ? 'i-ph-caret-down' : 'i-ph-caret-up'"
                                :aria-label="t('errors.runtime.details')"
                                @click="showRuntimeErrorDetails = !showRuntimeErrorDetails"
                            />
                        </AppTooltip>
                        <AppTooltip :text="t('errors.runtime.dismiss')" :delay-duration="400">
                            <UButton
                                color="neutral"
                                variant="ghost"
                                size="xs"
                                icon="i-ph-x"
                                :aria-label="t('errors.runtime.dismiss')"
                                @click="clearRuntimeErrorReports"
                            />
                        </AppTooltip>
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
import { useClipboard } from '@vueuse/core';
import { sumBy } from 'es-toolkit/math';
import AgentationWidget from '@app/components/AgentationWidget.vue';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    BROWSER_LOCALE_COOKIE_KEY,
    BROWSER_THEME_COOKIE_KEY,
} from '@app/utils/browserSettingsPersistence';
import { waitForVisualFrames } from '@app/utils/asyncHelpers';
import { markStartupMetricOnce } from '@app/utils/startupMetrics';
import {onBrowserDocumentPersistenceWarning} from '@app/platform/browser/browserDocumentPersistenceWarnings';
import {
    preloadStartupDocumentOpenChunks,
    shouldPreloadWorkspaceDuringStartup,
} from '@app/modules/workspace-shell/public';
import {
    isElectronUserAgent,
    waitForPreferredDesktopPlatformBridge,
} from '@app/utils/platform';
import { getDocumentFilesCapability } from '@app/utils/platformDocuments';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import {
    beginRecentOpenGeometryPrewarm,
    settleRecentOpenGeometryPrewarm,
} from '@app/modules/workspace-shell/host/recentOpenGeometryReadiness';
import { prewarmRecentDjvuOpeningGeometry } from '@app/modules/djvu-viewer/public/openGeometry';

const RECENT_OPEN_GEOMETRY_SETTLE_TIMEOUT_MS = 1_500;

const {
    load: loadSettings,
    settings,
} = useSettings();
const {
    effectiveScale: uiEffectiveScale,
    hostSnapshot: uiHostSnapshot,
    applyUiScaleToDocument,
    attachHostEnvironmentListener,
    refreshHostSnapshot,
    setPreferenceFromSettings,
} = useUiScale();
const hostEnvironmentUnsubscribers: Array<() => void> = [];
const toast = useToast();
let themeRepaintRevision = 0;
const {
    hasUsableInitialSnapshot: hasUsableInitialRecentFilesSnapshot,
    loadRecentFiles,
    recentFiles,
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
    reloadAfterFatalRuntimeError,
} = useFatalRuntimeError();
const {
    reports: runtimeErrorReports,
    reportRuntimeError,
    dismissRuntimeErrorReport,
    clearRuntimeErrorReports,
} = useRuntimeErrorReports();
const showRuntimeErrorDetails = ref(false);
const route = useRoute();
const colorMode = useColorMode();
const localeHead = useLocaleHead({
    dir: true,
    lang: true,
    seo: true,
});
const localeCookie = useCookie(BROWSER_LOCALE_COOKIE_KEY, { watch: false });
const themeCookie = useCookie(BROWSER_THEME_COOKIE_KEY, { watch: false });
const DEV_RELOAD_EVENT_KEY = 'evb-viewer:dev:last-vite-reload-event';
const fatalRuntimeTitle = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupTitle')
    : t('errors.runtime.title'));
const fatalRuntimeDescription = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupDescription')
    : t('errors.runtime.description'));
const runtimeErrorReportCount = computed(() => sumBy(runtimeErrorReports.value, report => report.count));
const {
    copied: recentlyCopiedFatalDetail,
    copy: copyFatalDetailToClipboard,
    isSupported: isFatalDetailClipboardSupported,
} = useClipboard({ copiedDuring: 1500 });
const {
    copied: recentlyCopiedReports,
    copy: copyReportsToClipboard,
    isSupported: isReportsClipboardSupported,
} = useClipboard({ copiedDuring: 1500 });

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

async function copyText(
    value: string,
    copyToClipboard: (value: string) => Promise<void>,
    isClipboardSupported: boolean,
) {
    if (!import.meta.client || !isClipboardSupported) {
        return false;
    }
    try {
        await copyToClipboard(value);
        return true;
    } catch (error) {
        BrowserLogger.warn('runtime-errors', 'Failed to copy runtime error report', error);
        return false;
    }
}

async function handleCopyFatalRuntimeDetail() {
    const detail = fatalRuntimeError.value?.detail;
    if (!detail) {
        return;
    }
    await copyText(detail, copyFatalDetailToClipboard, isFatalDetailClipboardSupported.value);
}

async function handleCopyReports() {
    await copyText(formatRuntimeErrorReports(), copyReportsToClipboard, isReportsClipboardSupported.value);
}

function reportStartupWarmupFailure(title: string, error: unknown) {
    BrowserLogger.warn('loader', title, error);
    reportRuntimeError({
        title,
        source: 'loader',
        error,
    });
}

function guardStartupWarmup(promise: Promise<unknown>, title: string) {
    void promise.catch(error => reportStartupWarmupFailure(title, error));
}

watch(() => colorMode.value, async () => {
    if (!import.meta.client) {
        return;
    }
    const revision = ++themeRepaintRevision;
    await nextTick();
    await waitForVisualFrames();
    if (revision !== themeRepaintRevision) {
        return;
    }

    // Hidden workspace tabs are retained with v-show. Some Chromium builds can
    // leave their composited layers painted in the prior color scheme until a
    // layout event occurs, so make the theme commit an explicit layout epoch.
    document.documentElement.getBoundingClientRect();
    window.dispatchEvent(new Event('resize'));
});

onBeforeUnmount(() => {
    themeRepaintRevision += 1;
    while (hostEnvironmentUnsubscribers.length > 0) {
        const unsubscribe = hostEnvironmentUnsubscribers.pop();
        try {
            unsubscribe?.();
        } catch (error) {
            BrowserLogger.warn('host-env', 'Failed to unsubscribe host environment listener', error);
        }
    }
});

colorMode.preference = settings.value.theme;

setPreferenceFromSettings(settings.value);

watch(
    () => settings.value.uiScale,
    () => {
        setPreferenceFromSettings(settings.value);
    },
);

useHead(() => ({
    htmlAttrs: {
        ...localeHead.value.htmlAttrs,
        dir: 'ltr',
        'data-platform': uiHostSnapshot.value.platform,
        style: `--app-ui-scale: ${uiEffectiveScale.value};`,
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
    // The active document workspace owns the canonical opening page frame.
    // Keep the startup barrier until that owner is available so a Recent-file
    // click can transition in the same frame instead of waiting on a lazy
    // chunk after the interactive shell has already been exposed.
    const shouldBlockOnRecentFiles = false;
    const shouldBlockOnDocumentOpenChunks = true;
    BrowserLogger.debug('loader', 'Startup content warmup started', {
        hasUsableInitialRecentFilesSnapshot: hasUsableInitialRecentFilesSnapshot.value,
        isDesktopRuntime: isDesktopRuntime.value,
        shouldBlockOnRecentFiles,
        shouldBlockOnDocumentOpenChunks,
    });

    const warmupTasks: Array<{
        title: string;
        promise: Promise<unknown>;
    }> = [];
    const recentFilesWarmup = loadRecentFiles();
    const recentPdfGeometryWarmup = recentFilesWarmup.then(async () => {
        const candidates = recentFiles.value
            .filter(file => /\.pdf$/iu.test(file.fileName || file.originalPath));
        beginRecentOpenGeometryPrewarm(candidates.map(file => file.originalPath));
        const { prewarmRecentPdfOpeningGeometry } = await import(
            '@app/modules/pdf-viewer/runtime/lifecycle/prewarmRecentPdfOpeningGeometry'
        );
        const documentFiles = getDocumentFilesCapability();
        const handleGeometryWarmupError = (file: {originalPath: string}, error: unknown) => BrowserLogger.debug(
            'recent-open',
            'Application-level Recent PDF geometry warmup unavailable',
            {
                path: file.originalPath,
                error: error instanceof Error ? error.message : String(error),
            },
        );
        const readOpeningGeometry = documentFiles.getPdfOpeningGeometry
            ? (path: string) => documentFiles.getPdfOpeningGeometry!(path)
            : undefined;
        const warmedGeometry = await prewarmRecentPdfOpeningGeometry(recentFiles.value, {readOpeningGeometry}, {
            limit: candidates.length,
            settleTimeoutMs: RECENT_OPEN_GEOMETRY_SETTLE_TIMEOUT_MS,
            onError: handleGeometryWarmupError,
            onSettled: (file, geometry) => settleRecentOpenGeometryPrewarm(
                file.originalPath,
                geometry ? 'ready' : 'cold-fallback',
            ),
        });
        return warmedGeometry;
    }).catch((error) => {
        for (const file of recentFiles.value
            .filter(file => /\.pdf$/iu.test(file.fileName || file.originalPath))) {
            settleRecentOpenGeometryPrewarm(file.originalPath, 'cold-fallback');
        }
        throw error;
    });
    guardStartupWarmup(recentPdfGeometryWarmup, 'Recent PDF opening geometry warmup failed');
    const recentDjvuGeometryWarmup = recentFilesWarmup.then(async () => {
        const candidates = recentFiles.value
            .filter(file => /\.djvu?$/iu.test(file.fileName || file.originalPath));
        beginRecentOpenGeometryPrewarm(candidates.map(file => file.originalPath));
        const djvu = getDjvuCapability();
        return prewarmRecentDjvuOpeningGeometry(recentFiles.value, {readSourceInfo: path => djvu.getPageSourceInfo(path, 1)}, {
            limit: candidates.length,
            settleTimeoutMs: RECENT_OPEN_GEOMETRY_SETTLE_TIMEOUT_MS,
            onSettled: (file, geometry) => settleRecentOpenGeometryPrewarm(
                file.originalPath,
                geometry ? 'ready' : 'cold-fallback',
            ),
        });
    }).catch((error) => {
        for (const file of recentFiles.value
            .filter(file => /\.djvu?$/iu.test(file.fileName || file.originalPath))) {
            settleRecentOpenGeometryPrewarm(file.originalPath, 'cold-fallback');
        }
        throw error;
    });
    guardStartupWarmup(recentDjvuGeometryWarmup, 'Recent DjVu opening geometry warmup failed');
    const recentOpenGeometryReadiness = Promise.allSettled([
        recentPdfGeometryWarmup,
        recentDjvuGeometryWarmup,
    ]).then(() => {
        markStartupMetricOnce('evb:recent-pdf-geometry-prewarmed');
    });
    guardStartupWarmup(recentOpenGeometryReadiness, 'Recent opening geometry readiness failed');
    if (shouldBlockOnRecentFiles) {
        warmupTasks.push({
            title: 'Recent files warmup failed',
            promise: recentFilesWarmup,
        });
    } else {
        guardStartupWarmup(recentFilesWarmup, 'Recent files warmup failed');
    }
    const preloadSignals = {
        isDesktopRuntime: isDesktopRuntime.value,
        isDev: import.meta.dev,
        ...(route.meta.preloadWorkspaceShell === false ? { routePreloadWorkspaceShell: false } : {}),
    };
    const shouldPreloadWorkspace = shouldPreloadWorkspaceDuringStartup(preloadSignals);
    const documentOpenChunkPreload = preloadStartupDocumentOpenChunks({
        isDesktopRuntime: isDesktopRuntime.value,
        shouldPreloadWorkspace,
    });
    if (documentOpenChunkPreload) {
        if (shouldBlockOnDocumentOpenChunks) {
            warmupTasks.unshift({
                title: 'Document open chunk preload failed',
                promise: documentOpenChunkPreload,
            });
        } else {
            guardStartupWarmup(documentOpenChunkPreload, 'Document open chunk preload failed');
        }
    }

    const results = await Promise.allSettled(warmupTasks.map(task => task.promise));
    for (const [
        index,
        result,
    ] of results.entries()) {
        if (result.status === 'rejected') {
            reportStartupWarmupFailure(warmupTasks[index]?.title ?? 'Startup warmup failed', result.reason);
        }
    }
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

    const hot = import.meta.hot;

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
        hostEnvironmentUnsubscribers.push(onBrowserDocumentPersistenceWarning(({
            fileName,
            error,
        }) => {
            BrowserLogger.warn('browser-storage', 'Document remains available only in memory', {
                fileName,
                error,
            });
            toast.add({
                color: 'warning',
                title: t('errors.file.browserStorageTitle'),
                description: t('errors.file.browserStorageDescription', {name: fileName}),
            });
        }));
        const bridgeResolution = await waitForPreferredDesktopPlatformBridge({
            routePath: route.path,
            desktopRuntime: isDesktopRuntime.value,
        });
        if (bridgeResolution.shouldWait && !bridgeResolution.bridgeReady && isElectronUserAgent()) {
            throw new Error('Electron preload bridge is unavailable during app bootstrap.');
        }

        applyUiScaleToDocument(uiEffectiveScale.value, uiHostSnapshot.value);
        const unsubscribeHostEnvironment = attachHostEnvironmentListener();
        hostEnvironmentUnsubscribers.push(unsubscribeHostEnvironment);
        void refreshHostSnapshot();
        await loadSettings();
        setPreferenceFromSettings(settings.value);
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
        markStartupMetricOnce('evb:shell-interactive');
    } catch (error) {
        BrowserLogger.error('loader', 'App bootstrap failed', error);
        setFatalRuntimeError('startup', error, 'app-bootstrap');
    } finally {
        // Always emit readiness, even on bootstrap failure, so preload fallbacks
        // can deterministically remove startup overlays and avoid hanging UI.
        if (typeof window !== 'undefined') {
            window.__appReady = true;
            window.__appReadyAt = mountTime;
            window.dispatchEvent(new Event('evb:app-ready'));
        }
    }
});
</script>

<style scoped>
.copy-report-button {
    transform-origin: center;
}

.runtime-error-reports {
    width: min(var(--app-runtime-report-width), calc(100vw - var(--app-runtime-report-viewport-gutter)));
}

.runtime-error-reports-card {
    max-height: min(var(--app-runtime-report-max-height), calc(100vh - var(--app-runtime-report-viewport-gutter)));
}

.runtime-error-report-details {
    max-height: min(var(--app-runtime-report-details-max-height), calc(100vh - var(--app-runtime-report-details-viewport-reserve)));
}

.copy-report-button--success {
    color: var(--ui-success);
    animation: copy-report-pop 420ms cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes copy-report-pop {
    0% {
        transform: scale(1);
    }

    45% {
        transform: scale(1.28);
    }

    100% {
        transform: scale(1);
    }
}

@media (prefers-reduced-motion: reduce) {
    .copy-report-button {
        transition: none;
    }

    .copy-report-button--success {
        animation: none;
    }
}
</style>
