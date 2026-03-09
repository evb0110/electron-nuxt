import type { Ref } from 'vue';
import { useTimeoutFn } from '@vueuse/core';

export function useToolbarTeleportBridge(isTabTransitionBusy: Readonly<Ref<boolean>>) {
    const globalToolbarHostRef = ref<HTMLElement | null>(null);
    const hasTeleportedToolbarContent = ref(false);
    let globalToolbarObserver: MutationObserver | null = null;
    let isMutatingGhosts = false;
    const GHOST_EXPIRY_MS = 200;

    const {
        start: startGhostExpiryTimer,
        stop: stopGhostExpiryTimer,
    } = useTimeoutFn(() => {
        clearToolbarGhostNodes();
        syncToolbarTeleportPresence();
    }, GHOST_EXPIRY_MS, { immediate: false });

    function clearGhostExpiryTimer() {
        stopGhostExpiryTimer();
    }

    function scheduleGhostExpiry() {
        clearGhostExpiryTimer();
        startGhostExpiryTimer();
    }

    function clearToolbarGhostNodes() {
        clearGhostExpiryTimer();
        const host = globalToolbarHostRef.value;
        if (!host) {
            return;
        }
        const ghosts = Array.from(host.querySelectorAll(':scope > [data-toolbar-ghost]'));
        if (ghosts.length === 0) {
            return;
        }
        isMutatingGhosts = true;
        for (const ghost of ghosts) {
            ghost.remove();
        }
        isMutatingGhosts = false;
    }

    function hasRealToolbarContent() {
        const host = globalToolbarHostRef.value;
        if (!host) {
            return false;
        }
        return Boolean(host.querySelector(':scope > :not([data-toolbar-ghost])'));
    }

    function hasAnyToolbarContent() {
        const host = globalToolbarHostRef.value;
        if (!host) {
            return false;
        }
        return host.children.length > 0;
    }

    function syncToolbarTeleportPresence() {
        const hasReal = hasRealToolbarContent();

        if (hasReal) {
            clearToolbarGhostNodes();
        }

        const hasContent = hasReal || hasAnyToolbarContent();
        if (hasTeleportedToolbarContent.value === hasContent) {
            return;
        }

        hasTeleportedToolbarContent.value = hasContent;
    }

    function observeToolbarHost() {
        syncToolbarTeleportPresence();
        const host = globalToolbarHostRef.value;
        if (typeof MutationObserver === 'undefined' || !host) {
            return;
        }

        globalToolbarObserver = new MutationObserver((mutations) => {
            if (isMutatingGhosts) {
                return;
            }
            if (isTabTransitionBusy.value && !hasRealToolbarContent()) {
                const currentHost = globalToolbarHostRef.value;
                if (currentHost) {
                    let injected = false;
                    isMutatingGhosts = true;
                    for (const mutation of mutations) {
                        for (const removed of mutation.removedNodes) {
                            if (removed instanceof HTMLElement) {
                                const ghost = removed.cloneNode(true) as HTMLElement;
                                ghost.dataset.toolbarGhost = '1';
                                ghost.inert = true;
                                currentHost.appendChild(ghost);
                                injected = true;
                            }
                        }
                    }
                    isMutatingGhosts = false;
                    if (injected) {
                        scheduleGhostExpiry();
                    }
                }
            }
            syncToolbarTeleportPresence();
        });
        globalToolbarObserver.observe(host, { childList: true });
    }

    function disposeToolbarTeleportBridge() {
        globalToolbarObserver?.disconnect();
        globalToolbarObserver = null;
        clearGhostExpiryTimer();
    }

    return {
        globalToolbarHostRef,
        hasTeleportedToolbarContent,
        syncToolbarTeleportPresence,
        observeToolbarHost,
        disposeToolbarTeleportBridge,
    };
}
