<script setup lang="ts">
import { resolveInitialDesktopRuntime } from '@app/utils/platform';

useServerSeoMeta({ robots: 'noindex, nofollow' });

if (import.meta.client && resolveInitialDesktopRuntime(useRoute().path)) {
    await navigateTo('/electron', { replace: true });
} else {
    await navigateTo('/', { replace: true });
}
</script>
