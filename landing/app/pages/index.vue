<template>
  <main
    class="home-shell"
    aria-labelledby="home-title"
  >
    <header class="home-topbar">
      <div class="home-brand">
        <NuxtLink
          class="brand-link"
          to="/"
        >
          <span class="brand-mark">EVB</span>
          <span class="brand-name">Viewer</span>
        </NuxtLink>

        <span
          v-if="releaseData"
          class="home-version"
        >
          {{ releaseData.release.tag }}
        </span>
      </div>

      <div class="home-actions">
        <UButton
          v-if="webAppUrl"
          :label="t('home.hero.openInBrowser')"
          :to="webAppUrl"
          target="_blank"
          rel="noreferrer"
          size="md"
          icon="i-lucide-globe"
        />

        <UButton
          :to="repositoryUrl"
          target="_blank"
          rel="noreferrer"
          color="neutral"
          variant="ghost"
          size="md"
          icon="i-simple-icons-github"
          square
          :aria-label="t('footer.viewSource')"
        />
      </div>
    </header>

    <section class="home-main">
      <div class="home-content">
        <div class="hero-copy">
          <h1
            id="home-title"
            class="hero-title"
          >
            {{ t('home.hero.title') }}
          </h1>

          <p class="hero-subtitle">
            {{ t('home.hero.subtitle') }}
          </p>
        </div>

        <div
          id="installers"
          class="installer-card installer-card-compact"
        >
          <div
            v-if="status === 'pending'"
            class="installer-state"
          >
            <p>{{ t('home.installers.loading') }}</p>
          </div>

          <div
            v-else-if="error"
            class="installer-state"
          >
            <p>{{ t('home.installers.error') }}</p>
            <UButton
              :label="t('home.installers.retry')"
              color="neutral"
              variant="outline"
              @click="refreshReleaseData"
            />
          </div>

          <div
            v-else-if="installersForSelectedPlatform.length"
            class="installer-content"
          >
            <div class="installer-platforms">
              <UButton
                v-for="tab in installerTabs"
                :key="tab"
                :label="installerPlatformLabel(tab)"
                size="sm"
                :variant="selectedInstallerTab === tab ? 'solid' : 'ghost'"
                :color="selectedInstallerTab === tab ? 'primary' : 'neutral'"
                class="installer-platform-button"
                @click="selectInstallerTab(tab)"
              />
            </div>

            <div class="installer-list">
              <button
                v-for="installer in installersForSelectedPlatform"
                :key="installer.id"
                type="button"
                class="installer-item"
                :class="{ 'installer-item-recommended': isRecommendedInstaller(installer) }"
                @click="trackDownload(installer); triggerIframeDownload(installer.downloadUrl)"
              >
                <div class="installer-item-info">
                  <div class="installer-item-header">
                    <span class="installer-item-variant">{{ installerLabel(installer) }}</span>
                    <span
                      v-if="isRecommendedInstaller(installer)"
                      class="installer-badge"
                    >
                      {{ t('home.installers.recommended') }}
                    </span>
                  </div>
                  <span class="installer-item-meta">
                    {{ formatFileSize(installer.size) }}
                  </span>
                </div>
                <UIcon
                  name="i-lucide-download"
                  class="installer-item-icon"
                />
              </button>
            </div>
          </div>

          <div
            v-else
            class="installer-state"
          >
            <p>{{ t('home.installers.noArtifacts') }}</p>
          </div>
        </div>
      </div>

      <figure class="hero-preview">
        <div class="preview-frame">
          <img
            class="preview-image"
            src="/evb-viewer-preview-cropped.png"
            :alt="t('home.preview.alt')"
            width="2936"
            height="1935"
            loading="eager"
            decoding="async"
            fetchpriority="high"
          >
        </div>
      </figure>
    </section>

    <footer class="home-bottom">
      <span class="home-copyright">{{ t('footer.copyright') }}</span>
    </footer>
  </main>
</template>

<script setup lang="ts">
import { useTimeoutFn } from '@vueuse/core';
import {
    buildAbsoluteUrl,
    normalizeSiteUrl,
    SEO_IMAGE_PATH,
} from '~~/shared/seo';
import { selectInstallersForPlatform } from '~~/shared/release-assets';
import {
    formatFileSize,
    formatInstallerLabel,
    formatPlatform,
    INSTALLER_PLATFORM_ORDER,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    type IReleaseInstaller,
    type TReleaseArch,
    type IUserAgentProfile,
    type TReleasePlatform,
} from '@release-selection';

interface INavigatorUADataLike {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

const { t } = useTypedI18n();
const route = useRoute();
const runtimeConfig = useRuntimeConfig();

const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
const siteUrl = computed(() => normalizeSiteUrl(runtimeConfig.public.siteUrl));
const webAppUrl = computed(() => runtimeConfig.public.webAppUrl?.trim() || '');
const canonicalUrl = computed(() => buildAbsoluteUrl(siteUrl.value, route.path));
const ogImage = computed(() => buildAbsoluteUrl(siteUrl.value, SEO_IMAGE_PATH));
const pageDescription = computed(() => t('home.seo.ogDescription'));

useSeoMeta({
    title: () => t('home.seo.title'),
    description: () => pageDescription.value,
    ogTitle: () => t('home.seo.ogTitle'),
    ogDescription: () => pageDescription.value,
    ogUrl: () => canonicalUrl.value,
    ogImage: () => ogImage.value,
    twitterTitle: () => t('home.seo.ogTitle'),
    twitterDescription: () => pageDescription.value,
    twitterImage: () => ogImage.value,
});

const clientProfile = ref<IUserAgentProfile>({
    platform: 'unknown',
    arch: 'unknown',
});

const {
    data: releaseData,
    error,
    refresh,
    status,
} = await useFetch('/api/releases/latest', { key: 'latest-release-data' });

const releaseAssets = computed(() => releaseData.value?.assets || []);
const installers = computed(() => releaseAssets.value.filter(asset => !asset.isLegacy));
const legacyInstallers = computed(() => releaseAssets.value.filter(asset => asset.isLegacy));

const selectablePlatforms = computed<TReleasePlatform[]>(() => INSTALLER_PLATFORM_ORDER.filter(
    platform => installers.value.some(asset => asset.platform === platform)
        || (platform === 'windows' && legacyInstallers.value.some(asset => asset.platform === 'windows')),
));

const installerTabs = computed<TReleasePlatform[]>(() => selectablePlatforms.value);

const recommendedInstaller = computed<IReleaseInstaller | null>(() => {
    if (!installers.value.length) {
        return null;
    }

    const clientSideChoice = recommendInstaller(installers.value, clientProfile.value);
    if (clientSideChoice) {
        return clientSideChoice;
    }

    const apiRecommendationId = releaseData.value?.recommendation.assetId;
    if (apiRecommendationId != null) {
        const apiRecommendation = installers.value.find(asset => asset.id === apiRecommendationId);
        if (apiRecommendation) {
            return apiRecommendation;
        }
    }

    return installers.value[0] || null;
});

const selectedInstallerTabOverride = ref<TReleasePlatform | null>(null);

const selectedInstallerTab = computed<TReleasePlatform>(() => {
    if (selectedInstallerTabOverride.value && installerTabs.value.includes(selectedInstallerTabOverride.value)) {
        return selectedInstallerTabOverride.value;
    }

    const recPlatform = recommendedInstaller.value?.platform || 'unknown';
    if (selectablePlatforms.value.includes(recPlatform)) {
        return recPlatform;
    }

    return selectablePlatforms.value[0] || 'unknown';
});

const installersForSelectedPlatform = computed(() => {
    const base = selectInstallersForPlatform(installers.value, selectedInstallerTab.value);

    if (selectedInstallerTab.value === 'windows') {
        return [...base, ...legacyInstallers.value];
    }

    return base;
});

const fallbackReleaseUrl = computed(() => releaseData.value?.release.htmlUrl || `${repositoryUrl}/releases/latest`);
const softwareApplicationSchema = computed(() => {
    const latestRelease = releaseData.value?.release;

    return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: t('app.title'),
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Web, macOS, Windows, Linux',
        description: pageDescription.value,
        url: canonicalUrl.value,
        image: ogImage.value,
        downloadUrl: fallbackReleaseUrl.value,
        author: {
            '@type': 'Person',
            name: 'Eugene Barsky',
        },
        offers: {
            '@type': 'Offer',
            price: '0',
            priceCurrency: 'USD',
        },
        softwareVersion: latestRelease?.tag,
        datePublished: latestRelease?.publishedAt,
    };
});

useHead(() => ({ script: [{
    key: 'software-application-schema',
    type: 'application/ld+json',
    textContent: JSON.stringify(softwareApplicationSchema.value),
}] }));

const pendingDownloadIframes = new Set<HTMLIFrameElement>();
const {
    start: startIframeCleanup,
    stop: stopIframeCleanup,
} = useTimeoutFn(() => {
    for (const iframe of pendingDownloadIframes) {
        iframe.remove();
    }
    pendingDownloadIframes.clear();
}, 60_000, { immediate: false });

onMounted(async () => {
    clientProfile.value = await detectClientProfile();
});

onBeforeUnmount(() => {
    stopIframeCleanup();
    for (const iframe of pendingDownloadIframes) {
        iframe.remove();
    }
    pendingDownloadIframes.clear();
});

async function detectClientProfile(): Promise<IUserAgentProfile> {
    const uaProfile = parseUserAgent(navigator.userAgent);
    const uaData = (navigator as Navigator & { userAgentData?: INavigatorUADataLike }).userAgentData;

    if (!uaData) {
        return uaProfile;
    }

    const hintedPlatform = parsePlatformHint(uaData.platform);
    let hintedArch: TReleaseArch = 'unknown';

    if (typeof uaData.getHighEntropyValues === 'function') {
        try {
            const entropyValues = await uaData.getHighEntropyValues(['architecture']);
            hintedArch = parseArchitectureHint(entropyValues.architecture);
        } catch {
            hintedArch = 'unknown';
        }
    }

    return {
        platform: hintedPlatform === 'unknown' ? uaProfile.platform : hintedPlatform,
        arch: hintedArch === 'unknown' ? uaProfile.arch : hintedArch,
    };
}

function triggerIframeDownload(url: string) {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
    iframe.src = url;
    pendingDownloadIframes.add(iframe);
    stopIframeCleanup();
    startIframeCleanup();
}

function trackDownload(installer: IReleaseInstaller) {
    if (typeof fetch !== 'function') {
        return;
    }

    fetch('/api/analytics/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            platform: installer.platform,
            arch: installer.arch,
            version: releaseData.value?.release.tag ?? 'unknown',
            fileName: installer.name,
        }),
    }).catch(() => {});
}

function isRecommendedInstaller(installer: IReleaseInstaller) {
    return recommendedInstaller.value?.id === installer.id;
}

function selectInstallerTab(tab: TReleasePlatform) {
    selectedInstallerTabOverride.value = tab;
}

function installerPlatformLabel(platform: TReleasePlatform): string {
    if (platform === 'macos') {
        return t('features.platforms.macOs');
    }

    if (platform === 'windows') {
        return t('features.platforms.windows');
    }

    if (platform === 'linux') {
        return t('features.platforms.linux');
    }

    return formatPlatform(platform);
}

function installerLabel(installer: IReleaseInstaller): string {
    if (installer.platform === 'windows' && installer.name.toLowerCase().includes('win7')) {
        return t('home.installers.legacy.win7Label');
    }

    return formatInstallerLabel(installer);
}

async function refreshReleaseData() {
    await refresh();
}
</script>
