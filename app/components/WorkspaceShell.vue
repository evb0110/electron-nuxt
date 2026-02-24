<template>
    <div class="workspace-shell">
        <slot />
    </div>
</template>

<style scoped>
.workspace-shell {
    display: flex;
    height: 100%;
    min-height: 0;
    min-width: 0;
    width: 100%;
    flex-direction: column;
}
</style>
