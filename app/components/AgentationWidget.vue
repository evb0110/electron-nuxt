<template>
    <div ref="agentationRootRef">
        <Agentation />
    </div>
</template>

<script setup lang="ts">
import { Agentation } from 'agentation-vue3';
import 'agentation-vue3/dist/style.css';

const agentationRootRef = useTemplateRef<HTMLElement>('agentationRootRef');
let observer: MutationObserver | null = null;

function removeNativeTooltips(root: HTMLElement) {
    root.querySelectorAll<HTMLElement>('[title]').forEach((element) => {
        const title = element.getAttribute('title');
        if (title && !element.getAttribute('aria-label')) {
            element.setAttribute('aria-label', title);
        }
        element.removeAttribute('title');
    });
}

function removeAgentationNativeTooltips() {
    const root = agentationRootRef.value;
    if (!root || typeof document === 'undefined') {
        return;
    }

    removeNativeTooltips(root);
    document
        .querySelectorAll<HTMLElement>('[class*="_controlButton_"][title]')
        .forEach((element) => removeNativeTooltips(element.parentElement ?? element));
}

onMounted(() => {
    if (typeof document === 'undefined') {
        return;
    }

    removeAgentationNativeTooltips();
    observer = new MutationObserver(removeAgentationNativeTooltips);
    observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['title'],
        childList: true,
        subtree: true,
    });
});

onBeforeUnmount(() => {
    observer?.disconnect();
    observer = null;
});
</script>
