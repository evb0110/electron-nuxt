<template>
  <main aria-labelledby="privacy-title">
    <section class="page-intro">
      <h1
        id="privacy-title"
        class="page-title"
      >
        Privacy Policy
      </h1>
      <p class="page-subtitle">
        How EVB Viewer handles documents, settings, analytics, and optional assistant features.
      </p>
      <p class="privacy-effective-date">
        Effective July 9, 2026
      </p>
    </section>

    <section class="content-section privacy-content">
      <div>
        <h2>Documents and local processing</h2>
        <p>
          EVB Viewer opens documents selected by you. Desktop document viewing, OCR, annotation,
          page operations, and export are performed on your device. The browser app processes
          selected documents in your browser unless you choose a feature that explicitly uses an
          external service. EVB Viewer does not upload your documents to the developer by default.
        </p>
      </div>

      <div>
        <h2>Optional assistant services</h2>
        <p>
          Assistant features are optional. When you use an assistant backed by Codex, OpenAI, or
          Anthropic Claude, prompts and any content or attachments you choose to include are sent
          to that provider under your account and are governed by that provider's terms and privacy
          policy. EVB Viewer does not sell this information.
        </p>
      </div>

      <div>
        <h2>Analytics and technical information</h2>
        <p>
          The EVB Viewer website and browser app may collect limited usage and technical events,
          such as page paths, feature events, locale, screen category, referrer, browser user agent,
          approximate region, and a rotating hashed visitor identifier. This information is used to
          understand reliability and product usage. It is not used to identify document contents.
        </p>
      </div>

      <div>
        <h2>Settings, recent files, and updates</h2>
        <p>
          App preferences, workspace state, and recent-file references may be stored locally on your
          device. The desktop app may contact GitHub to check for and download software updates.
          Operating-system and app-store services may process additional technical information under
          their own policies.
        </p>
      </div>

      <div>
        <h2>Retention and choices</h2>
        <p>
          Local app data remains on your device until you remove it or uninstall the app. You control
          which documents and attachments are opened or sent to optional assistant services. Website
          analytics records are retained only as needed for product operation, security, and trend
          analysis.
        </p>
      </div>

      <div>
        <h2>Contact</h2>
        <p>
          Questions or privacy requests can be submitted through the
          <a
            href="https://github.com/evb0110/evb-viewer/issues"
            target="_blank"
            rel="noreferrer"
          >EVB Viewer issue tracker</a>.
        </p>
      </div>
    </section>
  </main>
</template>

<script setup lang="ts">
useLandingPageSeo({
    title: () => 'Privacy Policy',
    description: () => 'Privacy policy for EVB Viewer desktop, browser, website, and optional assistant features.',
});
</script>

<style scoped>
.privacy-effective-date {
  color: var(--landing-muted);
  font-family: var(--font-mono);
  font-size: 0.82rem;
}

.privacy-content {
  display: grid;
  gap: 2rem;
  max-width: 54rem;
}

.privacy-content h2 {
  margin-bottom: 0.6rem;
  color: var(--landing-ink);
  font-size: 1.15rem;
}

.privacy-content p {
  margin: 0;
  color: var(--landing-ink-soft);
  line-height: 1.75;
}

.privacy-content a {
  color: var(--landing-accent);
  text-decoration: underline;
  text-underline-offset: 0.18rem;
}
</style>
