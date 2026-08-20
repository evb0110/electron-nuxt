<template>
    <main class="privacy-page">
        <article class="privacy-document">
            <header>
                <p class="privacy-brand">EVB Viewer</p>
                <h1>{{ privacyCopy.hero.title }}</h1>
                <p class="privacy-summary">
                    {{ privacyCopy.hero.subtitle }}
                </p>
                <p class="privacy-effective-date">{{ privacyCopy.hero.effectiveDate }}</p>
            </header>

            <section>
                <h2>{{ privacyCopy.documents.heading }}</h2>
                <p>{{ privacyCopy.documents.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.assistant.heading }}</h2>
                <p>{{ privacyCopy.assistant.body }}</p>
                <p>{{ privacyCopy.assistant.reportBody }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.analytics.heading }}</h2>
                <p>{{ privacyCopy.analytics.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.settings.heading }}</h2>
                <p>{{ privacyCopy.settings.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.storage.heading }}</h2>
                <p>{{ privacyCopy.storage.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.retention.heading }}</h2>
                <p>{{ privacyCopy.retention.body }}</p>
            </section>

            <section>
                <h2>{{ privacyCopy.contact.heading }}</h2>
                <p>
                    {{ privacyCopy.contact.intro }}
                    <a
                        href="https://github.com/evb0110/evb-viewer/issues"
                        rel="noreferrer"
                    >{{ privacyCopy.contact.linkLabel }}</a>.
                </p>
            </section>
        </article>
    </main>
</template>

<script setup lang="ts">
const PRIVACY_COPY = {
    en: {
        seo: {
            title: 'Privacy Policy | EVB Viewer',
            description: 'Privacy policy for EVB Viewer desktop, browser, website, and optional assistant features.',
        },
        hero: {
            title: 'Privacy Policy',
            subtitle: 'How EVB Viewer handles documents, settings, analytics, and optional assistant features.',
            effectiveDate: 'Effective August 19, 2026',
        },
        documents: {
            heading: 'Documents and local processing',
            body: 'EVB Viewer opens documents selected by you. Desktop document viewing, OCR, annotation, page operations, and export are performed on your device. The browser app processes selected documents in your browser unless you choose a feature that explicitly uses an external service. EVB Viewer does not upload your documents to the developer by default.',
        },
        assistant: {
            heading: 'Optional assistant services',
            body: 'Assistant features are optional. When you use an assistant backed by Codex, OpenAI, or Anthropic Claude, prompts and any content or attachments you choose to include are sent to that provider under your account and are governed by that provider\'s terms and privacy policy. EVB Viewer does not sell this information.',
            reportBody: 'Every assistant response includes a report control for inappropriate AI-generated content. It opens the EVB Viewer issue form, but does not copy or submit the response; you decide what to include and must avoid private or sensitive information.',
        },
        analytics: {
            heading: 'Analytics and technical information',
            body: 'The EVB Viewer website and browser app may collect limited usage and technical events, such as page paths, feature events, locale, screen category, referrer, browser user agent, approximate region, and a rotating hashed visitor identifier. This information is used to understand reliability and product usage. It is not used to identify document contents.',
        },
        settings: {
            heading: 'Settings, recent files, and updates',
            body: 'App preferences, workspace state, and recent-file references may be stored locally on your device. The desktop app may contact GitHub to check for and download software updates. Operating-system and app-store services may process additional technical information under their own policies.',
        },
        storage: {
            heading: 'Cookies and browser storage',
            body: 'EVB Viewer uses first-party preference cookies to remember language and, in the browser app, theme. Language cookies may last up to one year, and the theme cookie may last up to 180 days. The download site uses an opaque, HttpOnly cohort cookie for up to 90 days to keep staged release recommendations consistent; it is not used for advertising or cross-site tracking. The browser app also uses local storage, session storage, and IndexedDB for preferences, recent-file references, workspace state, document data you choose to retain, and a random per-session analytics identifier. EVB Viewer does not set advertising or third-party cookies. You can remove cookies and browser-stored data through your browser\'s site-data controls; doing so resets preferences and locally retained app data.',
        },
        retention: {
            heading: 'Retention and choices',
            body: 'Local app data remains on your device until you remove it or uninstall the app. You control which documents and attachments are opened or sent to optional assistant services. Website analytics records are retained only as needed for product operation, security, and trend analysis and are scheduled for automatic deletion after 90 days.',
        },
        contact: {
            heading: 'Contact',
            intro: 'Questions or privacy requests can be submitted through the',
            linkLabel: 'EVB Viewer issue tracker',
        },
    },
    ru: {
        seo: {
            title: 'Политика конфиденциальности | EVB Viewer',
            description: 'Политика конфиденциальности десктопного приложения, браузерной версии, сайта и опциональных функций ассистента EVB Viewer.',
        },
        hero: {
            title: 'Политика конфиденциальности',
            subtitle: 'Как EVB Viewer обрабатывает документы, настройки, аналитику и данные опциональных функций ассистента.',
            effectiveDate: 'Действует с 19 августа 2026 года',
        },
        documents: {
            heading: 'Документы и локальная обработка',
            body: 'EVB Viewer открывает выбранные вами документы. В десктопном приложении просмотр документов, OCR, аннотирование, операции со страницами и экспорт выполняются на вашем устройстве. Браузерная версия обрабатывает выбранные документы в браузере, если только вы не выберете функцию, которая явно использует внешний сервис. По умолчанию EVB Viewer не загружает ваши документы разработчику.',
        },
        assistant: {
            heading: 'Опциональные сервисы ассистента',
            body: 'Функции ассистента необязательны. При использовании ассистента на базе Codex, OpenAI или Anthropic Claude запросы, а также выбранные вами материалы и вложения отправляются соответствующему провайдеру через вашу учётную запись и регулируются его условиями и политикой конфиденциальности. EVB Viewer не продаёт эту информацию.',
            reportBody: 'Каждый ответ ассистента содержит элемент управления для жалобы на недопустимый контент, созданный ИИ. Он открывает форму задачи EVB Viewer, но не копирует и не отправляет ответ: вы сами решаете, что включить в сообщение, и должны исключить личную или конфиденциальную информацию.',
        },
        analytics: {
            heading: 'Аналитика и техническая информация',
            body: 'Сайт и браузерная версия EVB Viewer могут собирать ограниченные данные об использовании и технические события: пути страниц, события функций, язык, категорию экрана, источник перехода, user agent браузера, приблизительный регион и регулярно меняющийся хешированный идентификатор посетителя. Эти данные помогают оценивать надёжность и использование продукта и не применяются для определения содержимого документов.',
        },
        settings: {
            heading: 'Настройки, недавние файлы и обновления',
            body: 'Настройки приложения, состояние рабочего пространства и ссылки на недавние файлы могут храниться локально на вашем устройстве. Десктопное приложение может обращаться к GitHub для проверки и загрузки обновлений. Службы операционной системы и магазина приложений могут обрабатывать дополнительную техническую информацию согласно собственным политикам.',
        },
        storage: {
            heading: 'Файлы cookie и хранилища браузера',
            body: 'EVB Viewer использует собственные файлы cookie с настройками, чтобы запоминать язык и, в браузерной версии, тему. Файлы cookie языка могут храниться до одного года, а файл cookie темы — до 180 дней. Сайт загрузки использует непрозрачный файл cookie когорты с атрибутом HttpOnly сроком до 90 дней, чтобы рекомендации по поэтапно выпускаемым версиям оставались согласованными; он не используется для рекламы или межсайтового отслеживания. Браузерная версия также использует локальное и сеансовое хранилища и IndexedDB для настроек, ссылок на недавние файлы, состояния рабочего пространства, данных документов, которые вы решили сохранить, и случайного идентификатора аналитической сессии. EVB Viewer не устанавливает рекламные или сторонние файлы cookie. Удалить файлы cookie и данные браузера можно в настройках данных сайтов вашего браузера; при этом настройки и локально сохранённые данные приложения будут сброшены.',
        },
        retention: {
            heading: 'Хранение данных и ваш выбор',
            body: 'Локальные данные приложения остаются на устройстве, пока вы их не удалите или не удалите приложение. Вы сами выбираете, какие документы и вложения открывать или отправлять опциональным сервисам ассистента. Аналитические данные сайта хранятся только столько, сколько необходимо для работы продукта, безопасности и анализа тенденций, и планируются к автоматическому удалению через 90 дней.',
        },
        contact: {
            heading: 'Связаться с нами',
            intro: 'Вопросы и запросы о конфиденциальности можно отправить через',
            linkLabel: 'трекер задач EVB Viewer',
        },
    },
} as const;

const { locale } = useTypedI18n();
const privacyCopy = computed(() => PRIVACY_COPY[locale.value === 'ru' ? 'ru' : 'en']);

useHead(() => ({
    title: privacyCopy.value.seo.title,
    meta: [{
        name: 'description',
        content: privacyCopy.value.seo.description,
    }],
    link: [{
        rel: 'canonical',
        href: 'https://web.evb-viewer.com/privacy',
    }],
}));
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
