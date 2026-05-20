<template>
  <header class="site-header">
    <NuxtLink
      class="brand-link"
      :to="localePath('/')"
    >
      <span class="brand-mark">{{ brandTitle.mark }}</span>
      <span class="brand-name">{{ brandTitle.name }}</span>
    </NuxtLink>
  </header>
</template>

<script setup lang="ts">
const localePath = useLocalePath();
const { t } = useI18n();

const brandTitle = computed(() => {
    const [mark = '', ...nameParts] = t('app.title').split(' ');
    return {
        mark,
        name: nameParts.join(' '),
    };
});
</script>
