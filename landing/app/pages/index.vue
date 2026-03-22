<template>
  <main aria-labelledby="home-title">
    <section class="hero-grid section-reveal">
      <div class="hero-copy">
        <UBadge
          :label="t('home.hero.badge')"
          color="primary"
          variant="subtle"
          class="hero-badge"
        />

        <h1
          id="home-title"
          class="hero-title"
        >
          {{ t('home.hero.title') }}
        </h1>

        <p class="hero-subtitle">
          {{ t('home.hero.subtitle') }}
        </p>

        <div class="hero-cta">
          <UButton
            :label="downloadPrimaryLabel"
            icon="i-lucide-download"
            size="xl"
            class="ring ring-inset ring-primary"
            @click="downloadActiveInstaller"
          />

          <UButton
            :label="t('home.hero.browseInstallers')"
            color="neutral"
            variant="outline"
            size="xl"
            icon="i-lucide-list"
            @click="scrollToInstallers"
          />

          <UButton
            v-if="webAppUrl"
            :label="t('home.hero.openInBrowser')"
            :to="webAppUrl"
            target="_blank"
            rel="noreferrer"
            color="neutral"
            variant="link"
            size="xl"
            icon="i-lucide-globe"
            class="hero-web-app-link"
          />
        </div>

        <p class="hero-hint">
          {{ recommendationHint }}
        </p>

        <p
          v-if="releaseData"
          class="release-meta"
        >
          <strong>{{ releaseData.release.tag }}</strong>
          <span v-if="releaseDateLabel"> &middot; {{ t('home.hero.published', { date: releaseDateLabel }) }}</span>
        </p>

        <div class="hero-feature-strip">
          <UCard
            v-for="feature in featureHighlights"
            :key="feature.title"
            class="hero-feature-card"
          >
            <UIcon
              :name="feature.icon"
              class="feature-icon"
            />
            <h2>{{ feature.title }}</h2>
            <p>{{ feature.description }}</p>
          </UCard>
        </div>
      </div>

      <div class="hero-stack">
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
          <figcaption class="preview-caption">
            {{ t('home.preview.caption') }}
          </figcaption>
        </figure>

        <UCard class="hero-side-card">
          <div class="hero-side-head">
            <p
              v-if="releaseData"
              class="hero-side-eyebrow"
            >
              {{ releaseData.release.tag }}
            </p>
            <h2 class="hero-side-title">
              {{ downloadPrimaryLabel }}
            </h2>
            <p class="hero-side-copy">
              {{ recommendationHint }}
            </p>
          </div>

          <div class="hero-side-actions">
            <UButton
              :label="t('home.hero.openLatestRelease')"
              :to="fallbackReleaseUrl"
              target="_blank"
              icon="i-lucide-download"
              color="primary"
            />
            <UButton
              :label="t('home.explore.docsPage')"
              :to="localePath('/docs')"
              color="neutral"
              variant="outline"
              trailing-icon="i-lucide-arrow-right"
            />
          </div>

          <div class="hero-side-platforms">
            <div
              v-for="row in platformRows"
              :key="row.os"
              class="hero-platform-row"
            >
              <div>
                <p class="hero-platform-name">{{ row.os }}</p>
                <p class="hero-platform-meta">{{ row.architectures }}</p>
              </div>
              <span class="hero-platform-installers">{{ row.installerTypes }}</span>
            </div>
          </div>
        </UCard>
      </div>
    </section>

    <section class="content-section section-reveal section-delay-1">
      <div class="section-head">
        <h2>{{ t('features.capabilities.heading') }}</h2>
        <p>{{ t('features.capabilities.description') }}</p>
      </div>

      <div class="features-grid">
        <UCard
          v-for="feature in capabilityCards"
          :key="feature.title"
          class="feature-card"
        >
          <UIcon
            :name="feature.icon"
            class="feature-icon"
          />
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
        </UCard>
      </div>
    </section>

    <section
      id="installers"
      class="content-section section-reveal section-delay-2"
    >
      <div class="section-head">
        <h2>{{ t('home.installers.heading') }}</h2>
        <p>
          {{ t('home.installers.description') }}
        </p>
      </div>

      <div class="installer-layout">
        <div class="installer-card">
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
              @click="() => refresh()"
            />
          </div>

          <div
            v-else-if="installers.length"
            class="installer-content"
          >
            <div class="installer-platforms">
              <UButton
                v-for="platform in selectablePlatforms"
                :key="platform"
                :label="installerPlatformLabel(platform)"
                size="sm"
                :variant="selectedPlatform === platform ? 'solid' : 'ghost'"
                :color="selectedPlatform === platform ? 'primary' : 'neutral'"
                class="installer-platform-button"
                @click="selectPlatform(platform)"
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
                    <span class="installer-item-variant">{{ formatInstallerVariantLabel(installer) }}</span>
                    <span
                      v-if="isRecommendedInstaller(installer)"
                      class="installer-badge"
                    >
                      {{ t('home.installers.recommended') }}
                    </span>
                  </div>
                  <span class="installer-item-meta">
                    {{ installer.name }} · {{ formatFileSize(installer.size) }}
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

        <UCard class="release-sidebar">
          <div class="release-sidebar-head">
            <p
              v-if="releaseData"
              class="release-sidebar-tag"
            >
              {{ releaseData.release.tag }}
            </p>
            <h3>{{ t('features.platforms.heading') }}</h3>
            <p>{{ t('features.platforms.description') }}</p>
          </div>

          <div class="release-sidebar-platform-list">
            <div
              v-for="row in platformRows"
              :key="row.os"
              class="release-sidebar-row"
            >
              <div>
                <p class="release-sidebar-os">{{ row.os }}</p>
                <p class="release-sidebar-arch">{{ row.architectures }}</p>
              </div>
              <span class="release-sidebar-type">{{ row.installerTypes }}</span>
            </div>
          </div>

          <div class="release-sidebar-actions">
            <UButton
              :label="t('home.hero.openLatestRelease')"
              :to="fallbackReleaseUrl"
              target="_blank"
              icon="i-lucide-download"
              color="primary"
            />
            <UButton
              v-if="webAppUrl"
              :label="t('home.hero.openInBrowser')"
              :to="webAppUrl"
              target="_blank"
              rel="noreferrer"
              color="neutral"
              variant="outline"
              icon="i-lucide-globe"
            />
          </div>
        </UCard>
      </div>
    </section>

    <section class="content-section section-reveal section-delay-3">
      <div class="section-head">
        <h2>{{ t('features.workflow.heading') }}</h2>
        <p>{{ t('features.workflow.description') }}</p>
      </div>

      <div class="workflow-grid">
        <UCard
          v-for="(step, index) in workflowSteps"
          :key="step.title"
          class="workflow-card"
        >
          <p class="workflow-index">
            {{ String(index + 1).padStart(2, '0') }}
          </p>
          <h3>{{ step.title }}</h3>
          <p>{{ step.body }}</p>
        </UCard>
      </div>
    </section>

    <section class="content-section section-reveal section-delay-3">
      <div class="section-head">
        <h2>{{ t('home.explore.heading') }}</h2>
        <p>{{ t('home.explore.description') }}</p>
      </div>

      <div class="docs-grid">
        <UCard
          v-for="entry in docEntryCards"
          :key="entry.to"
          class="doc-card"
        >
          <UIcon
            :name="entry.icon"
            class="doc-icon"
          />
          <h3>{{ entry.title }}</h3>
          <p>{{ entry.description }}</p>
          <UButton
            :label="entry.action"
            :to="entry.to"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-arrow-right"
          />
        </UCard>
      </div>

      <div class="section-actions">
        <UButton
          :label="t('home.explore.featuresPage')"
          :to="localePath('/features')"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        />
        <UButton
          :label="t('home.explore.docsPage')"
          :to="localePath('/docs')"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        />
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
import { useTimeoutFn } from '@vueuse/core';
import {
    buildAbsoluteUrl,
    normalizeSiteUrl,
    SEO_IMAGE_PATH,
} from '~~/shared/seo';
import {
    compareInstallersForSelect,
    formatArch,
    formatFileSize,
    formatInstallerLabel,
    formatInstallerVariantLabel,
    formatPlatform,
    INSTALLER_PLATFORM_ORDER,
    parseArchitectureHint,
    parsePlatformHint,
    parseUserAgent,
    recommendInstaller,
    selectPreferredInstallers,
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
const { locale } = useI18n();
const route = useRoute();
const localePath = useLocalePath();
const runtimeConfig = useRuntimeConfig();

const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
const siteUrl = computed(() => normalizeSiteUrl(runtimeConfig.public.siteUrl));
const webAppUrl = computed(() => runtimeConfig.public.webAppUrl?.trim() || '');
const canonicalUrl = computed(() => buildAbsoluteUrl(siteUrl.value, route.path));
const ogImage = computed(() => buildAbsoluteUrl(siteUrl.value, SEO_IMAGE_PATH));
const pageDescription = computed(() => t('home.seo.ogDescription'));

const featureHighlights = computed(() => [
    {
        icon: 'i-lucide-file-stack',
        title: t('home.features.pdfDjvu.title'),
        description: t('home.features.pdfDjvu.description'),
    },
    {
        icon: 'i-lucide-text-search',
        title: t('home.features.ocr.title'),
        description: t('home.features.ocr.description'),
    },
    {
        icon: 'i-lucide-pen-tool',
        title: t('home.features.annotations.title'),
        description: t('home.features.annotations.description'),
    },
]);

const capabilityCards = computed(() => [
    {
        icon: 'i-lucide-file-stack',
        title: t('features.cards.pdfDjvu.title'),
        description: t('features.cards.pdfDjvu.description'),
    },
    {
        icon: 'i-lucide-text-search',
        title: t('features.cards.ocr.title'),
        description: t('features.cards.ocr.description'),
    },
    {
        icon: 'i-lucide-pen-tool',
        title: t('features.cards.annotations.title'),
        description: t('features.cards.annotations.description'),
    },
    {
        icon: 'i-lucide-scissors-square-dashed-bottom',
        title: t('features.cards.pages.title'),
        description: t('features.cards.pages.description'),
    },
    {
        icon: 'i-lucide-layout-panel-left',
        title: t('features.cards.workspace.title'),
        description: t('features.cards.workspace.description'),
    },
    {
        icon: 'i-lucide-folder-output',
        title: t('features.cards.exports.title'),
        description: t('features.cards.exports.description'),
    },
]);

const workflowSteps = computed(() => [
    {
        title: t('features.workflow.load.title'),
        body: t('features.workflow.load.body'),
    },
    {
        title: t('features.workflow.review.title'),
        body: t('features.workflow.review.body'),
    },
    {
        title: t('features.workflow.edit.title'),
        body: t('features.workflow.edit.body'),
    },
    {
        title: t('features.workflow.export.title'),
        body: t('features.workflow.export.body'),
    },
]);

const platformRows = computed(() => [
    {
        os: t('features.platforms.macOs'),
        architectures: t('features.platforms.macArch'),
        installerTypes: t('features.platforms.macInstallers'),
    },
    {
        os: t('features.platforms.windows'),
        architectures: t('features.platforms.winArch'),
        installerTypes: t('features.platforms.winInstallers'),
    },
    {
        os: t('features.platforms.linux'),
        architectures: t('features.platforms.linuxArch'),
        installerTypes: t('features.platforms.linuxInstallers'),
    },
]);

const docEntryCards = computed(() => [
    {
        icon: 'i-lucide-layout-panel-left',
        title: t('docs.bookmarks.workspaceOverview'),
        description: t('docs.workspace.intro'),
        action: t('home.explore.docsPage'),
        to: `${localePath('/docs')}#workspace-overview`,
    },
    {
        icon: 'i-lucide-file-stack',
        title: t('docs.bookmarks.openAndCombine'),
        description: t('docs.openCombine.li2'),
        action: t('home.explore.docsPage'),
        to: `${localePath('/docs')}#open-and-combine`,
    },
    {
        icon: 'i-lucide-pen-tool',
        title: t('docs.bookmarks.annotationsNotes'),
        description: t('docs.annotations.intro'),
        action: t('home.explore.docsPage'),
        to: `${localePath('/docs')}#annotations-notes`,
    },
    {
        icon: 'i-lucide-folder-output',
        title: t('docs.bookmarks.ocrExport'),
        description: t('docs.ocrExport.intro'),
        action: t('home.explore.docsPage'),
        to: `${localePath('/docs')}#ocr-export`,
    },
]);

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
} = useFetch('/api/releases/latest', { key: 'latest-release-data' });

const installers = computed(() => releaseData.value?.assets || []);

const selectablePlatforms = computed<TReleasePlatform[]>(() => INSTALLER_PLATFORM_ORDER.filter(
    platform => installers.value.some(asset => asset.platform === platform),
));

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

const platformOverride = ref<TReleasePlatform | null>(null);
const assetIdOverride = ref<number | undefined>(undefined);

const selectedPlatform = computed<TReleasePlatform>(() => {
    if (platformOverride.value && selectablePlatforms.value.includes(platformOverride.value)) {
        return platformOverride.value;
    }

    const recPlatform = recommendedInstaller.value?.platform || 'unknown';
    if (selectablePlatforms.value.includes(recPlatform)) {
        return recPlatform;
    }

    return selectablePlatforms.value[0] || 'unknown';
});

const installersForSelectedPlatform = computed(() => {
    return selectPreferredInstallers(installers.value, selectedPlatform.value).sort(compareInstallersForSelect);
});

const selectedAssetId = computed(() => {
    const items = installersForSelectedPlatform.value;
    if (!items.length) {
        return undefined;
    }

    if (assetIdOverride.value != null && items.some(a => a.id === assetIdOverride.value)) {
        return assetIdOverride.value;
    }

    const rec = recommendedInstaller.value;
    if (rec && rec.platform === selectedPlatform.value) {
        return rec.id;
    }

    return items[0]?.id;
});

const selectedInstaller = computed<IReleaseInstaller | null>(() => {
    if (!installersForSelectedPlatform.value.length) {
        return null;
    }

    const found = installersForSelectedPlatform.value.find(asset => asset.id === selectedAssetId.value);
    if (found) {
        return found;
    }

    return installersForSelectedPlatform.value[0] || null;
});

const activeDownload = computed(() => selectedInstaller.value || recommendedInstaller.value);
const fallbackReleaseUrl = computed(() => releaseData.value?.release.htmlUrl || `${repositoryUrl}/releases/latest`);
const softwareApplicationSchema = computed(() => {
    const latestRelease = releaseData.value?.release;

    return {
        '@context': 'https://schema.org',
        '@type': 'SoftwareApplication',
        name: t('app.title'),
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'macOS, Windows, Linux',
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

const downloadPrimaryLabel = computed(() => {
    const installer = recommendedInstaller.value;
    if (!installer) {
        return t('home.hero.openLatestRelease');
    }

    const platform = formatPlatform(installer.platform);
    const arch = formatArch(installer.arch);
    if (arch) {
        return t('home.hero.downloadForArch', {
            platform,
            arch,
        });
    }

    return t('home.hero.downloadFor', { platform });
});

const recommendationHint = computed(() => {
    const installer = recommendedInstaller.value;
    if (!installer) {
        return t('home.hero.detectionUnavailable');
    }

    return t('home.hero.suggestedDevice', { installerLabel: formatInstallerLabel(installer) });
});

const releaseDateLabel = computed(() => {
    const publishedAt = releaseData.value?.release.publishedAt;
    if (!publishedAt) {
        return '';
    }

    const publishedDate = new Date(publishedAt);
    if (Number.isNaN(publishedDate.getTime())) {
        return '';
    }

    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'long' }).format(publishedDate);
});

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

function downloadActiveInstaller() {
    const installer = activeDownload.value;
    if (installer) {
        trackDownload(installer);
        triggerIframeDownload(installer.downloadUrl);
    } else {
        window.open(fallbackReleaseUrl.value, '_blank');
    }
}

function isRecommendedInstaller(installer: IReleaseInstaller) {
    return recommendedInstaller.value?.id === installer.id;
}

function scrollToInstallers() {
    document.getElementById('installers')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
    });
}

function selectPlatform(platform: TReleasePlatform) {
    platformOverride.value = platform;
    assetIdOverride.value = undefined;
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
</script>
