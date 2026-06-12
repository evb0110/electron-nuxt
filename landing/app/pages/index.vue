<template>
  <main
    class="home-shell"
    aria-labelledby="home-title"
  >
    <header class="home-topbar">
      <div class="home-brand">
        <NuxtLink
          class="brand-link"
          :to="localePath('/')"
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
          color="neutral"
          variant="ghost"
          size="md"
          icon="i-ph-globe"
        />

        <LanguageSwitcher />

        <UButton
          :to="GITHUB_REPOSITORY_URL"
          target="_blank"
          rel="noreferrer"
          color="neutral"
          variant="outline"
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
          <p class="hero-eyebrow">
            {{ t('home.hero.badge') }}
          </p>

          <h1
            id="home-title"
            class="hero-title"
          >
            {{ t('home.hero.title') }}
          </h1>

          <p class="hero-subtitle">
            {{ t('home.hero.subtitle') }}
          </p>

          <p class="hero-ai-note">
            {{ t('home.hero.aiNote') }}
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
                color="neutral"
                :variant="selectedInstallerTab === tab ? 'solid' : 'ghost'"
                class="installer-platform-button"
                @click="selectInstallerTab(tab)"
              />
            </div>

            <div class="installer-list-slot">
              <div class="installer-list">
                <button
                  v-for="installer in installersForSelectedPlatform"
                  :key="installer.id"
                  type="button"
                  class="installer-item"
                  :class="{ 'installer-item-recommended': isRecommendedInstaller(installer) }"
                  :aria-label="downloadAriaLabel(installer)"
                  @click="downloadInstaller(installer)"
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
                    <span class="installer-item-detail">
                      {{ installerDetail(installer) }}
                    </span>
                    <span class="installer-item-meta">
                      {{ installerMeta(installer) }}
                    </span>
                  </div>
                  <span class="installer-item-chip">
                    <UIcon
                      name="i-ph-download"
                      class="installer-item-icon"
                    />
                  </span>
                </button>
              </div>
            </div>

            <p class="installer-hint">
              {{ installerPlatformHint }}
            </p>

            <NuxtLink
              class="installer-browse"
              :to="fallbackReleaseUrl"
              target="_blank"
              rel="noreferrer"
            >
              {{ t('home.hero.browseInstallers') }}
              <UIcon
                name="i-ph-arrow-right"
                class="installer-browse-icon"
              />
            </NuxtLink>
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
            width="2918"
            height="1898"
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
import { partition } from 'es-toolkit/array';
import { GITHUB_REPOSITORY_URL } from '~/constants/githubRepositoryUrl';
import { selectInstallersForPlatform } from '~~/shared/selectInstallersForPlatform';
import {
    formatFileSize,
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
} from '@releaseSelection';

interface INavigatorUADataLike {
    platform?: string
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>
}

const { t } = useTypedI18n();
const localePath = useLocalePath();
const runtimeConfig = useRuntimeConfig();

const webAppUrl = computed(() => runtimeConfig.public.webAppUrl?.trim() || '');
const pageDescription = computed(() => t('home.seo.ogDescription'));

const {
    canonicalUrl,
    ogImage,
} = useLandingPageSeo({
    title: () => t('home.seo.title'),
    description: () => pageDescription.value,
    ogTitle: () => t('home.seo.ogTitle'),
});

const clientProfile = useState<IUserAgentProfile>('landing-client-profile', () => {
    const userAgent = import.meta.server
        ? useRequestHeaders(['user-agent'])['user-agent'] ?? ''
        : navigator.userAgent;

    return buildClientProfile(userAgent);
});

const {
    data: releaseData,
    error,
    refresh,
    status,
} = await useFetch('/api/releases/latest', { key: 'latest-release-data' });

const releaseAssets = computed(() => releaseData.value?.assets ?? []);
const releaseAssetGroups = computed(() => {
    const [
        legacyInstallers,
        installers,
    ] = partition(releaseAssets.value, asset => asset.isLegacy);

    return {
        installers,
        legacyInstallers,
    };
});
const installers = computed(() => releaseAssetGroups.value.installers);
const legacyInstallers = computed(() => releaseAssetGroups.value.legacyInstallers);

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

    return installers.value[0] ?? null;
});

const selectedInstallerTabOverride = ref<TReleasePlatform | null>(null);

const selectedInstallerTab = computed<TReleasePlatform>(() => {
    if (selectedInstallerTabOverride.value && installerTabs.value.includes(selectedInstallerTabOverride.value)) {
        return selectedInstallerTabOverride.value;
    }

    const recPlatform = recommendedInstaller.value?.platform ?? 'unknown';
    if (selectablePlatforms.value.includes(recPlatform)) {
        return recPlatform;
    }

    return selectablePlatforms.value[0] ?? 'unknown';
});

const installersForSelectedPlatform = computed(() => {
    const base = selectInstallersForPlatform(installers.value, selectedInstallerTab.value);

    if (selectedInstallerTab.value === 'windows') {
        return [
            ...base,
            ...legacyInstallers.value,
        ];
    }

    return base;
});

const installerPlatformHint = computed(() => {
    if (selectedInstallerTab.value === 'macos') {
        return t('home.installers.platformHint.macos');
    }

    if (selectedInstallerTab.value === 'windows') {
        return t('home.installers.platformHint.windows');
    }

    if (selectedInstallerTab.value === 'linux') {
        return t('home.installers.platformHint.linux');
    }

    return t('home.installers.platformHint.default');
});

const fallbackReleaseUrl = computed(() => releaseData.value?.release.htmlUrl ?? `${GITHUB_REPOSITORY_URL}/releases/latest`);
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
    cleanupPendingDownloadIframes();
}, 60_000, { immediate: false });

onMounted(async () => {
    clientProfile.value = await detectClientProfile();
});

onBeforeUnmount(() => {
    stopIframeCleanup();
    cleanupPendingDownloadIframes();
});

function buildClientProfile(
    userAgent: string,
    hintedPlatform: TReleasePlatform = 'unknown',
    hintedArch: TReleaseArch = 'unknown',
): IUserAgentProfile {
    const uaProfile = parseUserAgent(userAgent);
    const platform = hintedPlatform === 'unknown' ? uaProfile.platform : hintedPlatform;

    if (hintedArch !== 'unknown') {
        return {
            platform,
            arch: hintedArch, 
        };
    }

    if (platform === 'macos') {
        return {
            platform,
            arch: 'arm64', 
        };
    }

    return {
        platform,
        arch: uaProfile.arch, 
    };
}

async function detectClientProfile(): Promise<IUserAgentProfile> {
    const uaData = (navigator as Navigator & { userAgentData?: INavigatorUADataLike }).userAgentData;

    if (!uaData) {
        return buildClientProfile(navigator.userAgent);
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

    return buildClientProfile(navigator.userAgent, hintedPlatform, hintedArch);
}

function cleanupPendingDownloadIframes() {
    for (const iframe of pendingDownloadIframes) {
        iframe.remove();
    }
    pendingDownloadIframes.clear();
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

function trackInstallerDownload(installer: IReleaseInstaller) {
    trackDownload({
        platform: installer.platform,
        arch: installer.arch,
        version: releaseData.value?.release.tag ?? 'unknown',
        fileName: installer.name,
    });
}

function downloadInstaller(installer: IReleaseInstaller) {
    trackInstallerDownload(installer);
    triggerIframeDownload(installer.downloadUrl);
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

    const arch = normalizedInstallerArch(installer);

    if (installer.platform === 'macos') {
        if (arch === 'arm64') {
            return t('home.installers.arch.appleSilicon');
        }

        if (arch === 'x64') {
            return t('home.installers.arch.intelMac');
        }
    }

    if (arch === 'x64') {
        return t('home.installers.arch.x64');
    }

    if (arch === 'arm64') {
        return t('home.installers.arch.arm64');
    }

    if (arch === 'universal') {
        return t('home.installers.arch.universal');
    }

    return packageLabel(installer);
}

function normalizedInstallerArch(installer: IReleaseInstaller): TReleaseArch {
    if (installer.platform === 'linux' && installer.extension === 'appimage' && installer.arch === 'unknown') {
        return 'x64';
    }

    return installer.arch;
}

function packageLabel(installer: IReleaseInstaller): string {
    if (installer.extension === 'appimage') {
        return t('home.installers.package.appImage');
    }

    if (installer.extension === 'deb') {
        return t('home.installers.package.deb');
    }

    if (installer.extension === 'dmg') {
        return t('home.installers.package.dmg');
    }

    if (installer.extension === 'exe') {
        return t('home.installers.package.exe');
    }

    if (installer.extension === 'zip') {
        return t('home.installers.package.zip');
    }

    return installer.extension.toUpperCase();
}

function installerDetail(installer: IReleaseInstaller): string {
    if (installer.platform === 'windows' && installer.name.toLowerCase().includes('win7')) {
        return t('home.installers.detail.win7Legacy');
    }

    if (installer.platform === 'linux' && installer.extension === 'deb') {
        return t('home.installers.detail.linuxDeb');
    }

    if (installer.platform === 'linux' && installer.extension === 'appimage') {
        return t('home.installers.detail.linuxAppImage');
    }

    if (installer.platform === 'macos' && normalizedInstallerArch(installer) === 'arm64') {
        return t('home.installers.detail.macosArm64');
    }

    if (installer.platform === 'macos' && normalizedInstallerArch(installer) === 'x64') {
        return t('home.installers.detail.macosX64');
    }

    if (installer.platform === 'windows' && normalizedInstallerArch(installer) === 'arm64') {
        return t('home.installers.detail.windowsArm64');
    }

    if (installer.platform === 'windows' && normalizedInstallerArch(installer) === 'x64') {
        return t('home.installers.detail.windowsX64');
    }

    return packageLabel(installer);
}

function installerMeta(installer: IReleaseInstaller): string {
    return t('home.installers.packageSize', {
        package: packageLabel(installer),
        size: formatFileSize(installer.size),
    });
}

function downloadAriaLabel(installer: IReleaseInstaller): string {
    return t('home.hero.downloadInstaller', {installerLabel: `${installerLabel(installer)} ${packageLabel(installer)}`});
}

async function refreshReleaseData() {
    await refresh();
}
</script>
