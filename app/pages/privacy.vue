<template>
    <main class="privacy-page">
        <article class="privacy-document">
            <header>
                <p class="privacy-brand">EVB Viewer</p>
                <h1>Privacy Policy</h1>
                <p class="privacy-summary">
                    How EVB Viewer handles documents, settings, analytics, and optional assistant features.
                </p>
                <p class="privacy-effective-date">Effective July 9, 2026</p>
            </header>

            <section>
                <h2>Documents and local processing</h2>
                <p>
                    EVB Viewer opens documents selected by you. Desktop document viewing, OCR, annotation,
                    page operations, and export are performed on your device. The browser app processes
                    selected documents in your browser unless you choose a feature that explicitly uses an
                    external service. EVB Viewer does not upload your documents to the developer by default.
                </p>
            </section>

            <section>
                <h2>Optional assistant services</h2>
                <p>
                    Assistant features are optional. When you use an assistant backed by Codex, OpenAI, or
                    Anthropic Claude, prompts and any content or attachments you choose to include are sent
                    to that provider under your account and are governed by that provider's terms and privacy
                    policy. EVB Viewer does not sell this information.
                </p>
            </section>

            <section>
                <h2>Analytics and technical information</h2>
                <p>
                    The EVB Viewer website and browser app may collect limited usage and technical events,
                    such as page paths, feature events, locale, screen category, referrer, browser user agent,
                    approximate region, and a rotating hashed visitor identifier. This information is used to
                    understand reliability and product usage. It is not used to identify document contents.
                </p>
            </section>

            <section>
                <h2>Settings, recent files, and updates</h2>
                <p>
                    App preferences, workspace state, and recent-file references may be stored locally on your
                    device. The desktop app may contact GitHub to check for and download software updates.
                    Operating-system and app-store services may process additional technical information under
                    their own policies.
                </p>
            </section>

            <section>
                <h2>Retention and choices</h2>
                <p>
                    Local app data remains on your device until you remove it or uninstall the app. You control
                    which documents and attachments are opened or sent to optional assistant services. Website
                    analytics records are retained only as needed for product operation, security, and trend
                    analysis.
                </p>
            </section>

            <section>
                <h2>Contact</h2>
                <p>
                    Questions or privacy requests can be submitted through the
                    <a href="https://github.com/evb0110/evb-viewer/issues">EVB Viewer issue tracker</a>.
                </p>
            </section>
        </article>
    </main>
</template>

<script setup lang="ts">
useHead({
    title: 'Privacy Policy | EVB Viewer',
    meta: [{
        name: 'description',
        content: 'Privacy policy for EVB Viewer desktop, browser, website, and optional assistant features.',
    }],
    link: [{
        rel: 'canonical',
        href: 'https://web.evb-viewer.com/privacy',
    }],
});
</script>

<style scoped>
.privacy-page {
    min-height: 100dvh;
    padding: var(--app-privacy-page-padding) var(--app-privacy-inline-padding) var(--app-privacy-responsive-padding);
    background: var(--ui-bg);
    color: var(--ui-text);
}

.privacy-document {
    width: min(100%, var(--app-privacy-document-max-width));
    margin: 0 auto;
}

.privacy-document header {
    padding-bottom: var(--app-privacy-footer-padding);
    border-bottom: 1px solid var(--ui-border);
}

.privacy-brand,
.privacy-effective-date {
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-body);
}

.privacy-brand {
    margin: 0 0 var(--app-space-3xl);
    font-weight: 700;
}

.privacy-document h1 {
    margin: 0;
    font-size: var(--app-privacy-title-size);
    line-height: 1.1;
}

.privacy-summary {
    max-width: var(--app-privacy-measure);
    margin: var(--app-space-6xl) 0 0;
    color: var(--ui-text-muted);
    font-size: var(--app-text-size-title-md);
    line-height: 1.6;
}

.privacy-effective-date {
    margin: var(--app-space-6xl) 0 0;
}

.privacy-document section {
    padding-top: var(--app-privacy-section-margin);
}

.privacy-document h2 {
    margin: 0 0 var(--app-space-lg);
    font-size: var(--app-icon-size-lg);
}

.privacy-document p {
    margin: 0;
    line-height: 1.75;
}

.privacy-document a {
    color: var(--ui-primary);
    text-decoration: underline;
    text-underline-offset: var(--app-space-xs);
}

@media (width >= 48rem) {
    .privacy-page {
        padding-top: var(--app-privacy-responsive-padding);
    }

    .privacy-document h1 {
        font-size: var(--app-privacy-title-size-wide);
    }
}
</style>
