<template>
  <main aria-labelledby="docs-title">
    <section class="page-intro section-reveal">
      <UBadge
        :label="t('header.nav.docs')"
        color="primary"
        variant="subtle"
      />
      <h1
        id="docs-title"
        class="page-title"
      >
        {{ t('docs.seo.title') }}
      </h1>
      <p class="page-subtitle">
        {{ t('docs.seo.ogDescription') }}
      </p>

      <div class="section-actions">
        <UButton
          :label="t('home.hero.openLatestRelease')"
          :to="latestReleaseUrl"
          target="_blank"
          icon="i-lucide-download"
          color="neutral"
          variant="outline"
        />
        <UButton
          :label="t('home.explore.featuresPage')"
          :to="localePath('/features')"
          color="neutral"
          variant="outline"
          trailing-icon="i-lucide-arrow-right"
        />
      </div>
    </section>

    <section class="content-section section-reveal section-delay-1">
      <div class="section-head">
        <h2>{{ t('home.explore.heading') }}</h2>
        <p>{{ t('home.explore.description') }}</p>
      </div>

      <div class="docs-grid">
        <UCard
          v-for="entry in guideCards"
          :key="entry.id"
          class="doc-card"
        >
          <UIcon
            :name="entry.icon"
            class="doc-icon"
          />
          <h3>{{ entry.title }}</h3>
          <p>{{ entry.description }}</p>
          <UButton
            :label="t('home.explore.docsPage')"
            color="neutral"
            variant="outline"
            trailing-icon="i-lucide-arrow-right"
            @click="scrollToBookmark(entry.id)"
          />
        </UCard>
      </div>
    </section>

    <div class="docs-layout section-reveal section-delay-2">
      <aside class="docs-bookmark-column">
        <UCard class="docs-bookmark-card">
          <p class="bookmark-title">
            {{ t('docs.bookmarks.title') }}
          </p>
          <nav class="bookmark-nav">
            <button
              v-for="entry in bookmarks"
              :key="entry.id"
              type="button"
              class="bookmark-link"
              @click="scrollToBookmark(entry.id)"
            >
              {{ entry.title }}
            </button>
          </nav>
          <UButton
            :label="t('docs.bookmarks.repository')"
            :to="repositoryUrl"
            target="_blank"
            icon="i-simple-icons-github"
            color="neutral"
            variant="outline"
          />
        </UCard>
      </aside>

      <main class="docs-main">
        <section
          id="workspace-overview"
          class="docs-section"
        >
          <h2>{{ t('docs.workspace.heading') }}</h2>
          <p>
            {{ t('docs.workspace.intro') }}
          </p>
          <ul class="docs-list">
            <li>{{ t('docs.workspace.li1') }}</li>
            <li>{{ t('docs.workspace.li2') }}</li>
            <li>{{ t('docs.workspace.li3') }}</li>
            <li>{{ t('docs.workspace.li4') }}</li>
            <li>{{ t('docs.workspace.li5') }}</li>
          </ul>
        </section>

        <section
          id="unsigned-installation"
          class="docs-section"
        >
          <h2>{{ t('docs.unsigned.heading') }}</h2>
          <p>
            {{ t('docs.unsigned.intro') }}
          </p>
          <ul class="docs-list">
            <i18n-t
              keypath="docs.unsigned.li1"
              tag="li"
              scope="global"
            >
              <template #repo><code>evb0110/evb-viewer</code></template>
            </i18n-t>
            <li>{{ t('docs.unsigned.li2') }}</li>
          </ul>
          <p><strong>{{ t('docs.unsigned.macosHeading') }}</strong></p>
          <ul class="docs-list">
            <li>{{ t('docs.unsigned.macosLi1') }}</li>
            <i18n-t
              keypath="docs.unsigned.macosLi2"
              tag="li"
              scope="global"
            >
              <template #open><code>Open</code></template>
            </i18n-t>
            <i18n-t
              keypath="docs.unsigned.macosLi3"
              tag="li"
              scope="global"
            >
              <template #openAnyway><code>Open Anyway</code></template>
            </i18n-t>
          </ul>
          <p><strong>{{ t('docs.unsigned.windowsHeading') }}</strong></p>
          <ul class="docs-list">
            <li>{{ t('docs.unsigned.windowsLi1') }}</li>
            <i18n-t
              keypath="docs.unsigned.windowsLi2"
              tag="li"
              scope="global"
            >
              <template #moreInfo><code>More info</code></template>
              <template #runAnyway><code>Run anyway</code></template>
            </i18n-t>
            <li>{{ t('docs.unsigned.windowsLi3') }}</li>
          </ul>
          <p><strong>{{ t('docs.unsigned.linuxHeading') }}</strong></p>
          <ul class="docs-list">
            <li>{{ t('docs.unsigned.linuxLi1') }}</li>
            <i18n-t
              keypath="docs.unsigned.linuxLi2"
              tag="li"
              scope="global"
            >
              <template #command><code>sudo apt install ./evb-viewer-*.deb</code></template>
            </i18n-t>
            <li>{{ t('docs.unsigned.linuxLi3') }}</li>
          </ul>
        </section>

        <section
          id="open-and-combine"
          class="docs-section"
        >
          <h2>{{ t('docs.openCombine.heading') }}</h2>
          <i18n-t
            keypath="docs.openCombine.intro"
            tag="p"
            scope="global"
          >
            <template #menuPath><code>File > Open File...</code></template>
          </i18n-t>
          <ul class="docs-list">
            <li>{{ t('docs.openCombine.li1') }}</li>
            <li>{{ t('docs.openCombine.li2') }}</li>
            <i18n-t
              keypath="docs.openCombine.li3"
              tag="li"
              scope="global"
            >
              <template #example><code>report-combined.pdf</code></template>
            </i18n-t>
            <li>{{ t('docs.openCombine.li4') }}</li>
            <i18n-t
              keypath="docs.openCombine.li5"
              tag="li"
              scope="global"
            >
              <template #openRecent><code>Open Recent</code></template>
            </i18n-t>
          </ul>
          <i18n-t
            keypath="docs.openCombine.convertIntro"
            tag="p"
            scope="global"
          >
            <template #menuPath><code>File > Convert to PDF...</code></template>
          </i18n-t>
        </section>

        <section
          id="tabs-and-splits"
          class="docs-section"
        >
          <h2>{{ t('docs.tabsSplits.heading') }}</h2>
          <p>
            {{ t('docs.tabsSplits.intro') }}
          </p>
          <ul class="docs-list">
            <li>{{ t('docs.tabsSplits.li1') }}</li>
            <i18n-t
              keypath="docs.tabsSplits.li2"
              tag="li"
              scope="global"
            >
              <template #menuPath><code>View > Editor Groups > Split Editor</code></template>
            </i18n-t>
            <li>{{ t('docs.tabsSplits.li3') }}</li>
            <i18n-t
              keypath="docs.tabsSplits.li4"
              tag="li"
              scope="global"
            >
              <template #command><code>Focus Editor Group</code></template>
            </i18n-t>
            <i18n-t
              keypath="docs.tabsSplits.li5"
              tag="li"
              scope="global"
            >
              <template #moveTab><code>Move Tab to Group</code></template>
              <template #copyTab><code>Copy Tab to Group</code></template>
            </i18n-t>
          </ul>
        </section>

        <section
          id="window-management"
          class="docs-section"
        >
          <h2>{{ t('docs.windowMgmt.heading') }}</h2>
          <p>
            {{ t('docs.windowMgmt.intro') }}
          </p>
          <ul class="docs-list">
            <i18n-t
              keypath="docs.windowMgmt.li1"
              tag="li"
              scope="global"
            >
              <template #menuPath><code>Window > Move Active Tab to New Window</code></template>
            </i18n-t>
            <i18n-t
              keypath="docs.windowMgmt.li2"
              tag="li"
              scope="global"
            >
              <template #menuPath><code>Window > Move Active Tab to Window</code></template>
            </i18n-t>
            <i18n-t
              keypath="docs.windowMgmt.li3"
              tag="li"
              scope="global"
            >
              <template #menuPath><code>Window > Merge This Window Into</code></template>
            </i18n-t>
            <li>{{ t('docs.windowMgmt.li4') }}</li>
            <li>{{ t('docs.windowMgmt.li5') }}</li>
          </ul>
        </section>

        <section
          id="pages-panel"
          class="docs-section"
        >
          <h2>{{ t('docs.pagesPanel.heading') }}</h2>
          <ul class="docs-list">
            <li>{{ t('docs.pagesPanel.li1') }}</li>
            <i18n-t
              keypath="docs.pagesPanel.li2"
              tag="li"
              scope="global"
            >
              <template #shift><code>Shift</code></template>
              <template #cmdCtrl><code>Cmd/Ctrl</code></template>
            </i18n-t>
            <li>{{ t('docs.pagesPanel.li3') }}</li>
            <li>{{ t('docs.pagesPanel.li4') }}</li>
            <li>{{ t('docs.pagesPanel.li5') }}</li>
            <li>{{ t('docs.pagesPanel.li6') }}</li>
          </ul>
        </section>

        <section
          id="annotations-notes"
          class="docs-section"
        >
          <h2>{{ t('docs.annotations.heading') }}</h2>
          <p>
            {{ t('docs.annotations.intro') }}
          </p>
          <ul class="docs-list">
            <li>{{ t('docs.annotations.li1') }}</li>
            <li>{{ t('docs.annotations.li2') }}</li>
            <li>{{ t('docs.annotations.li3') }}</li>
            <li>{{ t('docs.annotations.li4') }}</li>
            <li>{{ t('docs.annotations.li5') }}</li>
          </ul>
        </section>

        <section
          id="bookmarks-panel"
          class="docs-section"
        >
          <h2>{{ t('docs.bookmarksPanelSection.heading') }}</h2>
          <ul class="docs-list">
            <li>{{ t('docs.bookmarksPanelSection.li1') }}</li>
            <li>{{ t('docs.bookmarksPanelSection.li2') }}</li>
            <li>{{ t('docs.bookmarksPanelSection.li3') }}</li>
            <li>{{ t('docs.bookmarksPanelSection.li4') }}</li>
            <li>{{ t('docs.bookmarksPanelSection.li5') }}</li>
          </ul>
        </section>

        <section
          id="search-navigation"
          class="docs-section"
        >
          <h2>{{ t('docs.search.heading') }}</h2>
          <ul class="docs-list">
            <i18n-t
              keypath="docs.search.li1"
              tag="li"
              scope="global"
            >
              <template #shortcut><code>Cmd/Ctrl + F</code></template>
            </i18n-t>
            <li>{{ t('docs.search.li2') }}</li>
            <i18n-t
              keypath="docs.search.li3"
              tag="li"
              scope="global"
            >
              <template #enter><code>Enter</code></template>
              <template #shiftEnter><code>Shift + Enter</code></template>
            </i18n-t>
            <li>{{ t('docs.search.li4') }}</li>
            <li>{{ t('docs.search.li5') }}</li>
          </ul>
        </section>

        <section
          id="ocr-export"
          class="docs-section"
        >
          <h2>{{ t('docs.ocrExport.heading') }}</h2>
          <p>
            {{ t('docs.ocrExport.intro') }}
          </p>
          <ul class="docs-list">
            <li>{{ t('docs.ocrExport.li1') }}</li>
            <li>{{ t('docs.ocrExport.li2') }}</li>
            <li>{{ t('docs.ocrExport.li3') }}</li>
            <li>{{ t('docs.ocrExport.li4') }}</li>
            <i18n-t
              keypath="docs.ocrExport.li5"
              tag="li"
              scope="global"
            >
              <template #command><code>Export DOCX</code></template>
            </i18n-t>
            <i18n-t
              keypath="docs.ocrExport.li6"
              tag="li"
              scope="global"
            >
              <template #exportImages><code>Export Images...</code></template>
              <template #exportTiff><code>Export Multi-page TIFF...</code></template>
            </i18n-t>
            <i18n-t
              keypath="docs.ocrExport.li7"
              tag="li"
              scope="global"
            >
              <template #captureRegion><code>Capture Region</code></template>
              <template #esc><code>Esc</code></template>
            </i18n-t>
          </ul>
        </section>

        <section
          id="menus-shortcuts"
          class="docs-section"
        >
          <h2>{{ t('docs.menusShortcuts.heading') }}</h2>
          <UCard class="table-card">
            <div class="table-wrap">
              <table class="platform-table">
                <thead>
                  <tr>
                    <th scope="col">
                      {{ t('docs.menusShortcuts.menuCol') }}
                    </th>
                    <th scope="col">
                      {{ t('docs.menusShortcuts.menuActionsCol') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="row in menuMap"
                    :key="row.menu"
                  >
                    <td>{{ row.menu }}</td>
                    <td>{{ row.actions }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </UCard>
          <UCard class="table-card">
            <div class="table-wrap">
              <table class="platform-table">
                <thead>
                  <tr>
                    <th scope="col">
                      {{ t('docs.menusShortcuts.actionCol') }}
                    </th>
                    <th scope="col">
                      {{ t('docs.menusShortcuts.shortcutCol') }}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="shortcut in shortcuts"
                    :key="shortcut.action"
                  >
                    <td>{{ shortcut.action }}</td>
                    <td>{{ shortcut.keys }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </UCard>
          <p>
            {{ t('docs.menusShortcuts.contextMenuNote') }}
          </p>
          <p>
            {{ t('docs.menusShortcuts.repoNote') }}
          </p>
        </section>

        <section
          id="license"
          class="docs-section"
        >
          <h2>{{ t('docs.license.heading') }}</h2>
          <p>{{ t('docs.license.text') }}</p>
        </section>
      </main>
    </div>
  </main>
</template>

<script setup lang="ts">
import {
    buildAbsoluteUrl,
    normalizeSiteUrl,
    SEO_IMAGE_PATH,
} from '~~/shared/seo';

const { t } = useTypedI18n();
const route = useRoute();
const localePath = useLocalePath();
const runtimeConfig = useRuntimeConfig();

const repositoryUrl = 'https://github.com/evb0110/evb-viewer';
const latestReleaseUrl = 'https://github.com/evb0110/evb-viewer/releases/latest';
const siteUrl = computed(() => normalizeSiteUrl(runtimeConfig.public.siteUrl));
const canonicalUrl = computed(() => buildAbsoluteUrl(siteUrl.value, route.path));
const ogImage = computed(() => buildAbsoluteUrl(siteUrl.value, SEO_IMAGE_PATH));
const pageDescription = computed(() => t('docs.seo.ogDescription'));

const bookmarks = computed(() => [
    {
        id: 'workspace-overview',
        title: t('docs.bookmarks.workspaceOverview'),
    },
    {
        id: 'unsigned-installation',
        title: t('docs.bookmarks.unsignedInstallation'),
    },
    {
        id: 'open-and-combine',
        title: t('docs.bookmarks.openAndCombine'),
    },
    {
        id: 'tabs-and-splits',
        title: t('docs.bookmarks.tabsAndSplits'),
    },
    {
        id: 'window-management',
        title: t('docs.bookmarks.windowManagement'),
    },
    {
        id: 'pages-panel',
        title: t('docs.bookmarks.pagesPanel'),
    },
    {
        id: 'annotations-notes',
        title: t('docs.bookmarks.annotationsNotes'),
    },
    {
        id: 'bookmarks-panel',
        title: t('docs.bookmarks.bookmarksPanel'),
    },
    {
        id: 'search-navigation',
        title: t('docs.bookmarks.searchNavigation'),
    },
    {
        id: 'ocr-export',
        title: t('docs.bookmarks.ocrExport'),
    },
    {
        id: 'menus-shortcuts',
        title: t('docs.bookmarks.menusShortcuts'),
    },
    {
        id: 'license',
        title: t('docs.bookmarks.license'),
    },
]);

const guideCards = computed(() => [
    {
        id: 'workspace-overview',
        icon: 'i-lucide-layout-panel-left',
        title: t('docs.bookmarks.workspaceOverview'),
        description: t('docs.workspace.intro'),
    },
    {
        id: 'open-and-combine',
        icon: 'i-lucide-file-stack',
        title: t('docs.bookmarks.openAndCombine'),
        description: t('docs.openCombine.li2'),
    },
    {
        id: 'annotations-notes',
        icon: 'i-lucide-pen-tool',
        title: t('docs.bookmarks.annotationsNotes'),
        description: t('docs.annotations.intro'),
    },
    {
        id: 'ocr-export',
        icon: 'i-lucide-folder-output',
        title: t('docs.bookmarks.ocrExport'),
        description: t('docs.ocrExport.intro'),
    },
]);

const shortcuts = computed(() => [
    {
        action: t('docs.menusShortcuts.shortcutOpenFile'),
        keys: 'Cmd/Ctrl + O',
    },
    {
        action: t('docs.menusShortcuts.shortcutSave'),
        keys: 'Cmd/Ctrl + S',
    },
    {
        action: t('docs.menusShortcuts.shortcutSaveAs'),
        keys: 'Cmd/Ctrl + Shift + S',
    },
    {
        action: t('docs.menusShortcuts.shortcutExportDocx'),
        keys: 'Cmd/Ctrl + Shift + E',
    },
    {
        action: t('docs.menusShortcuts.shortcutNewTab'),
        keys: 'Cmd/Ctrl + T',
    },
    {
        action: t('docs.menusShortcuts.shortcutCloseTab'),
        keys: 'Cmd/Ctrl + W',
    },
    {
        action: t('docs.menusShortcuts.shortcutUndo'),
        keys: 'Cmd/Ctrl + Z',
    },
    {
        action: t('docs.menusShortcuts.shortcutRedo'),
        keys: 'Cmd + Shift + Z (macOS) / Ctrl + Y (Windows/Linux)',
    },
    {
        action: t('docs.menusShortcuts.shortcutZoomIn'),
        keys: 'Cmd/Ctrl + =',
    },
    {
        action: t('docs.menusShortcuts.shortcutZoomOut'),
        keys: 'Cmd/Ctrl + -',
    },
    {
        action: t('docs.menusShortcuts.shortcutActualSize'),
        keys: 'Cmd/Ctrl + 0',
    },
    {
        action: t('docs.menusShortcuts.shortcutFitWidth'),
        keys: 'Cmd/Ctrl + 1',
    },
    {
        action: t('docs.menusShortcuts.shortcutFitHeight'),
        keys: 'Cmd/Ctrl + 2',
    },
    {
        action: t('docs.menusShortcuts.shortcutSplitEditor'),
        keys: 'Cmd/Ctrl + \\',
    },
    {
        action: t('docs.menusShortcuts.shortcutFind'),
        keys: 'Cmd/Ctrl + F',
    },
    {
        action: t('docs.menusShortcuts.shortcutCycleTabs'),
        keys: 'Ctrl + Tab / Ctrl + Shift + Tab',
    },
]);

const menuMap = computed(() => [
    {
        menu: t('docs.menusShortcuts.menuFile'),
        actions: t('docs.menusShortcuts.menuFileActions'),
    },
    {
        menu: t('docs.menusShortcuts.menuActions'),
        actions: t('docs.menusShortcuts.menuActionsActions'),
    },
    {
        menu: t('docs.menusShortcuts.menuPages'),
        actions: t('docs.menusShortcuts.menuPagesActions'),
    },
    {
        menu: t('docs.menusShortcuts.menuView'),
        actions: t('docs.menusShortcuts.menuViewActions'),
    },
    {
        menu: t('docs.menusShortcuts.menuWindow'),
        actions: t('docs.menusShortcuts.menuWindowActions'),
    },
    {
        menu: t('docs.menusShortcuts.menuHelp'),
        actions: t('docs.menusShortcuts.menuHelpActions'),
    },
]);

useSeoMeta({
    title: () => t('docs.seo.title'),
    description: () => pageDescription.value,
    ogTitle: () => t('docs.seo.ogTitle'),
    ogDescription: () => pageDescription.value,
    ogUrl: () => canonicalUrl.value,
    ogImage: () => ogImage.value,
    twitterTitle: () => t('docs.seo.ogTitle'),
    twitterDescription: () => pageDescription.value,
    twitterImage: () => ogImage.value,
});

function scrollToBookmark(id: string) {
    document.getElementById(id)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
    });
    window.history.replaceState(null, '', `#${id}`);
}
</script>
