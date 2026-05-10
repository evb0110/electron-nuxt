<template>
    <UTooltip
        :text="text"
        :content="content"
        :arrow="arrow"
        :portal="portal"
        :class="tooltipClass"
        :default-open="defaultOpen"
        :open="open"
        :delay-duration="delayDuration"
        :disable-hoverable-content="disableHoverableContent"
        :disable-closing-trigger="disableClosingTrigger"
        :disabled="disabled || !isUseful"
        :ignore-non-keyboard-focus="ignoreNonKeyboardFocus"
        :reference="referenceElement"
        @update:open="emit('update:open', $event)"
    >
        <span
            ref="triggerRef"
            class="app-tooltip-trigger"
            @pointerenter="refreshUsefulness"
            @focusin="refreshUsefulness"
        >
            <slot />
        </span>

        <template v-if="$slots.content" #content="slotProps">
            <slot name="content" v-bind="slotProps" />
        </template>
    </UTooltip>
</template>

<script setup lang="ts">
type TTooltipUsefulness = 'auto' | 'always' | 'overflow' | 'no-text';
type TTooltipClass = string | string[] | Record<string, boolean> | undefined;
type TTooltipObject = Record<string, unknown>;
type TTooltipPortal = boolean | string | HTMLElement;

interface IAppTooltipProps {
    text?: string;
    content?: TTooltipObject;
    arrow?: boolean | TTooltipObject;
    portal?: TTooltipPortal;
    class?: TTooltipClass;
    defaultOpen?: boolean;
    open?: boolean;
    delayDuration?: number;
    disableHoverableContent?: boolean;
    disableClosingTrigger?: boolean;
    disabled?: boolean;
    ignoreNonKeyboardFocus?: boolean;
    usefulness?: TTooltipUsefulness;
}

const {
    text = undefined,
    content = undefined,
    arrow = undefined,
    portal = true,
    class: tooltipClass = undefined,
    defaultOpen = undefined,
    open = undefined,
    delayDuration = undefined,
    disableHoverableContent = undefined,
    disableClosingTrigger = undefined,
    disabled = false,
    ignoreNonKeyboardFocus = undefined,
    usefulness = 'auto',
} = defineProps<IAppTooltipProps>();

const emit = defineEmits<{ 'update:open': [value: boolean] }>();

const triggerRef = useTemplateRef<HTMLElement>('triggerRef');
const referenceElement = shallowRef<HTMLElement | undefined>();
const isUseful = ref(usefulness === 'always' || usefulness === 'auto' || usefulness === 'no-text');

function refreshReferenceElement() {
    const root = triggerRef.value;
    const reference = root?.firstElementChild;

    referenceElement.value = reference instanceof HTMLElement ? reference : root ?? undefined;
}

function hasUsefulText(element: HTMLElement): boolean {
    return (element.innerText ?? '').trim().length > 0;
}

function isElementOverflowing(element: Element): boolean {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    return element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1;
}

function hasOverflowingContent(root: HTMLElement): boolean {
    const trigger = root.firstElementChild ?? root;
    if (isElementOverflowing(trigger)) {
        return true;
    }

    return Array.from(trigger.querySelectorAll('*')).some(isElementOverflowing);
}

function refreshUsefulness() {
    const root = triggerRef.value;
    if (!root) {
        return;
    }

    refreshReferenceElement();

    const hasText = hasUsefulText(root);
    const isOverflowing = hasOverflowingContent(root);

    isUseful.value = usefulness === 'always'
        || (usefulness === 'no-text' && !hasText)
        || (usefulness === 'overflow' && isOverflowing)
        || (usefulness === 'auto' && (!hasText || isOverflowing));
}

watch(() => usefulness, refreshUsefulness);
onMounted(refreshUsefulness);
onUpdated(refreshReferenceElement);
</script>

<style scoped>
.app-tooltip-trigger {
    display: contents;
}
</style>
