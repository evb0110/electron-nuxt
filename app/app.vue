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
import { hasElectronAPI } from '@app/utils/electron';
import { waitForVisualFrames } from '@app/utils/async-helpers';

const {
    load: loadSettings,
    settings,
} = useSettings();
const { loadRecentFiles } = useRecentFiles();
const {
    t,
    setLocale,
} = useTypedI18n();
const {
    fatalRuntimeError,
    setFatalRuntimeError,
    clearFatalRuntimeError,
    reloadAfterFatalRuntimeError,
} = useFatalRuntimeError();
const colorMode = useColorMode();
const DEV_RELOAD_EVENT_KEY = 'evb-viewer:dev:last-vite-reload-event';
const fatalRuntimeTitle = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupTitle')
    : t('errors.runtime.title'));
const fatalRuntimeDescription = computed(() => fatalRuntimeError.value?.kind === 'startup'
    ? t('errors.runtime.startupDescription')
    : t('errors.runtime.description'));

async function preloadStartupContent() {
    if (!import.meta.client) {
        return;
    }

    const warmupStartedAt = performance.now();
    BrowserLogger.debug('loader', 'Startup content warmup started', { hasElectronApi: hasElectronAPI() });

    const warmupTasks: Array<Promise<unknown>> = [import('@app/modules/workspace-shell/components/DocumentWorkspace.vue')];

    if (hasElectronAPI()) {
        warmupTasks.push(loadRecentFiles());
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
            const previousEvent = JSON.parse(rawPreviousEvent);
            BrowserLogger.warn('dev-reload', 'Previous Vite reload event (persisted)', previousEvent);
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

        BrowserLogger.warn('dev-reload', 'Vite announced full reload', event);
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
        // Load persisted settings and apply locale + theme
        await loadSettings();
        if (settings.value.locale) {
            await setLocale(settings.value.locale);
        }
        if (settings.value.theme) {
            colorMode.preference = settings.value.theme;
        }

        await preloadStartupContent();
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
