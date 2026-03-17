<script setup lang="ts">
import { hasElectronAPI } from '@app/utils/platform';

if (import.meta.client && hasElectronAPI()) {
    await navigateTo('/electron', { replace: true });
} else {
    await navigateTo('/', { replace: true });
}
</script>
