// @vitest-environment happy-dom

import {
    readFileSync,
    readdirSync,
} from 'node:fs';
import { resolve } from 'node:path';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createApp } from 'vue';
import SentryAcknowledgement from '@landing/app/components/SentryAcknowledgement.vue';

vi.mock('@landing/app/composables/useTypedI18n', () => ({useTypedI18n: () => ({t: (key: string) => ({
    'footer.sentryAcknowledgement.message': 'Thank you to Sentry for supporting EVB Viewer through its open-source program.',
    'footer.sentryAcknowledgement.linkLabel': 'Learn about Sentry for Open Source',
}[key] ?? key)})}));

const projectRoot = process.cwd();
const componentSource = readFileSync(
    resolve(projectRoot, 'landing/app/components/SentryAcknowledgement.vue'),
    'utf8',
);
const siteFooterSource = readFileSync(
    resolve(projectRoot, 'landing/app/components/SiteFooter.vue'),
    'utf8',
);
const homeSource = readFileSync(
    resolve(projectRoot, 'landing/app/pages/index.vue'),
    'utf8',
);
const wordmarkSource = readFileSync(
    resolve(projectRoot, 'landing/public/sentry-wordmark.svg'),
    'utf8',
);
const provenanceSource = readFileSync(
    resolve(projectRoot, 'landing/public/sentry-wordmark.provenance.md'),
    'utf8',
);
const activeUnmounts = new Set<() => void>();

function mountAcknowledgement() {
    const host = document.createElement('div');
    document.body.append(host);
    const app = createApp(SentryAcknowledgement);
    app.mount(host);
    const unmount = () => {
        app.unmount();
        host.remove();
        activeUnmounts.delete(unmount);
    };
    activeUnmounts.add(unmount);

    return {
        host,
        unmount,
    };
}

afterEach(() => {
    for (const unmount of [...activeUnmounts]) {
        unmount();
    }
    vi.unstubAllGlobals();
});

describe('SentryAcknowledgement', () => {
    it('renders the local wordmark and secure OSS link without making a request', () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const mounted = mountAcknowledgement();
        const image = mounted.host.querySelector<HTMLImageElement>('.sentry-wordmark');
        const link = mounted.host.querySelector<HTMLAnchorElement>('a');

        expect(mounted.host.textContent).toContain('Thank you to Sentry for supporting EVB Viewer');
        expect(image?.getAttribute('src')).toBe('/sentry-wordmark.svg');
        expect(image?.getAttribute('alt')).toBe('Sentry');
        expect(link?.href).toBe('https://sentry.io/for/open-source/');
        expect(link?.target).toBe('_blank');
        expect(link?.rel).toBe('noopener noreferrer');
        expect(link?.tabIndex).toBe(0);
        link?.focus();
        expect(document.activeElement).toBe(link);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps one local acknowledgement implementation in both footer paths', () => {
        const componentFiles = readdirSync(resolve(projectRoot, 'landing/app/components'));
        const acknowledgementFiles = componentFiles.filter(file => file === 'SentryAcknowledgement.vue');

        expect(acknowledgementFiles).toEqual(['SentryAcknowledgement.vue']);
        expect(siteFooterSource.match(/<SentryAcknowledgement\b/gu)).toHaveLength(1);
        expect(homeSource.match(/<SentryAcknowledgement\b/gu)).toHaveLength(1);
        expect(siteFooterSource).toContain('import SentryAcknowledgement from \'./SentryAcknowledgement.vue\';');
        expect(homeSource).toContain('import SentryAcknowledgement from \'~/components/SentryAcknowledgement.vue\';');

        expect(wordmarkSource).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 44">');
        expect(wordmarkSource).toContain('<path fill="currentColor"');
        expect(provenanceSource).toContain('https://sentry.io/branding/');
        expect(componentSource).toContain('const SENTRY_WORDMARK_PATH = \'/sentry-wordmark.svg\';');
        expect(componentSource).not.toMatch(/https?:\/\/[^"']+sentry[^"']+\.svg/iu);
        expect(componentSource).not.toMatch(/filter\s*:/u);
        expect(componentSource).toContain(':focus-visible');
        expect(componentSource).toContain('@media (width <= 40rem)');
        expect(componentSource).not.toMatch(/fetch|XMLHttpRequest|sendBeacon/u);
    });
});
