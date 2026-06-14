<template>
  <header class="site-header">
    <NuxtLink
      class="brand-link"
      :to="localePath('/')"
    >
      <span class="brand-mark">EVB</span>
      <span class="brand-name">Viewer</span>
    </NuxtLink>

    <div class="header-actions">
      <LanguageSwitcher />
    </div>
  </header>
</template>

<script setup lang="ts">
const localePath = useLocalePath();
</script>
