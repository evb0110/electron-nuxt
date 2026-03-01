<template>
    <UApp>
        <NuxtPage />
        <DevOnly>
            <ClientOnly>
                <AgentationWidget />
            </ClientOnly>
        </DevOnly>
    </UApp>
</template>

<script setup lang="ts">
import { BrowserLogger } from '@app/utils/browser-logger';
import { hasElectronAPI } from '@app/utils/electron';

const {
    load: loadSettings,
    settings,
} = useSettings();
const { loadRecentFiles } = useRecentFiles();
const { setLocale } = useTypedI18n();
const colorMode = useColorMode();
const DEV_RELOAD_EVENT_KEY = 'evb-viewer:dev:last-vite-reload-event';

async function waitForNextPaintFrame() {
    await new Promise<void>((resolve) => {
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => resolve());
            return;
        }

        setTimeout(resolve);
    });
}

async function preloadStartupContent() {
    if (!import.meta.client) {
        return;
    }

    const warmupStartedAt = performance.now();
    BrowserLogger.debug('loader', 'Startup content warmup started', { hasElectronApi: hasElectronAPI() });

    const warmupTasks: Array<Promise<unknown>> = [import('@app/components/DocumentWorkspace.vue')];

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
    await waitForNextPaintFrame();

    // Expose for testing (set after hydration/mount, not during module evaluation).
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
});
</script>
