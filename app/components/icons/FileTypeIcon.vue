<template>
    <svg
        v-if="kind === 'pdf'"
        viewBox="0 0 32 36"
        fill="none"
        aria-hidden="true"
    >
        <path
            d="M5 2.4A2 2 0 0 1 7 .4h13.5L29 8.9V32a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V2.4Z"
            fill="var(--app-file-icon-pdf-fill)"
            stroke="var(--app-file-icon-pdf-stroke)"
            stroke-width="0.8"
        />
        <path
            d="M20.5.4 29 8.9h-6.5a2 2 0 0 1-2-2V.4Z"
            fill="var(--app-file-icon-pdf-fold)"
        />
        <rect
            x="3.5"
            y="18"
            width="20"
            height="9"
            rx="1.5"
            fill="var(--app-file-icon-pdf-badge)"
        />
        <text
            x="13.5"
            y="24.7"
            text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="6.4"
            font-weight="700"
            fill="#ffffff"
            letter-spacing="0.02em"
        >PDF</text>
    </svg>
    <svg
        v-else-if="kind === 'djvu'"
        viewBox="0 0 32 36"
        fill="none"
        aria-hidden="true"
    >
        <path
            d="M5 2.4A2 2 0 0 1 7 .4h13.5L29 8.9V32a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V2.4Z"
            fill="var(--app-file-icon-djvu-fill)"
            stroke="var(--app-file-icon-djvu-stroke)"
            stroke-width="0.8"
        />
        <path
            d="M20.5.4 29 8.9h-6.5a2 2 0 0 1-2-2V.4Z"
            fill="var(--app-file-icon-djvu-fold)"
        />
        <rect
            x="2.5"
            y="18"
            width="22"
            height="9"
            rx="1.5"
            fill="var(--app-file-icon-djvu-badge)"
        />
        <text
            x="13.5"
            y="24.7"
            text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="5.6"
            font-weight="700"
            fill="#ffffff"
            letter-spacing="0.02em"
        >DjVu</text>
    </svg>
    <svg
        v-else-if="kind === 'image'"
        viewBox="0 0 32 36"
        fill="none"
        aria-hidden="true"
    >
        <path
            d="M5 2.4A2 2 0 0 1 7 .4h13.5L29 8.9V32a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V2.4Z"
            fill="var(--app-file-icon-image-fill)"
            stroke="var(--app-file-icon-image-stroke)"
            stroke-width="0.8"
        />
        <path
            d="M20.5.4 29 8.9h-6.5a2 2 0 0 1-2-2V.4Z"
            fill="var(--app-file-icon-image-fold)"
        />
        <rect
            x="3.5"
            y="18"
            width="20"
            height="9"
            rx="1.5"
            fill="var(--app-file-icon-image-badge)"
        />
        <text
            x="13.5"
            y="24.7"
            text-anchor="middle"
            font-family="ui-sans-serif, system-ui, sans-serif"
            font-size="5.6"
            font-weight="700"
            fill="#ffffff"
            letter-spacing="0.02em"
        >IMG</text>
    </svg>
    <svg
        v-else
        viewBox="0 0 32 36"
        fill="none"
        aria-hidden="true"
    >
        <path
            d="M5 2.4A2 2 0 0 1 7 .4h13.5L29 8.9V32a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V2.4Z"
            fill="var(--app-file-icon-doc-fill)"
            stroke="var(--app-file-icon-doc-stroke)"
            stroke-width="0.8"
        />
        <path
            d="M20.5.4 29 8.9h-6.5a2 2 0 0 1-2-2V.4Z"
            fill="var(--app-file-icon-doc-fold)"
        />
        <path
            d="M9 17h14"
            stroke="var(--app-file-icon-doc-line)"
            stroke-width="1.4"
            stroke-linecap="round"
        />
        <path
            d="M9 21h14"
            stroke="var(--app-file-icon-doc-line)"
            stroke-width="1.4"
            stroke-linecap="round"
        />
        <path
            d="M9 25h9"
            stroke="var(--app-file-icon-doc-line)"
            stroke-width="1.4"
            stroke-linecap="round"
        />
    </svg>
</template>

<script setup lang="ts">
defineProps<{ kind: 'document' | 'djvu' | 'image' | 'pdf' }>();
</script>