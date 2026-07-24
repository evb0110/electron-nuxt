import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type { THostResourceTier } from '@contracts/hostResourceProfile';
import {startConfiguredElectronE2ESession} from '@tests/e2e/electron/helpers/startConfiguredElectronE2ESession';
import type {IElectronE2ESession} from '@tests/e2e/electron/helpers/startElectronE2ESession';

const E2E_TIMEOUT_MS = 180_000;
const APP_READY_TIMEOUT_MS = 60_000;

interface IRootProfileSnapshot {
    appLowGraphics: boolean;
    profileAccessWasSynchronous: boolean;
    profileTier: THostResourceTier | null;
    tierClasses: string[];
}

interface IGraphicsStyleSnapshot {
    djvuBackdropFilter: string;
    nativePdfBackdropFilter: string;
    thumbnailAnimationName: string;
    thumbnailWillChange: string;
}

async function waitForAppReady(session: IElectronE2ESession) {
    await session.page.waitForFunction(
        () => (window as Window & {__appReady?: boolean}).__appReady === true,
        {timeout: APP_READY_TIMEOUT_MS},
    );
}

async function readRootProfileSnapshot(session: IElectronE2ESession): Promise<IRootProfileSnapshot> {
    return session.page.evaluate(() => {
        let microtaskReached = false;
        queueMicrotask(() => {
            microtaskReached = true;
        });
        const profile = window.electronAPI?.host.getResourceProfile() ?? null;
        return {
            appLowGraphics: document.documentElement.classList.contains('app-low-graphics'),
            profileAccessWasSynchronous: !microtaskReached && !(profile && 'then' in profile),
            profileTier: profile?.tier ?? null,
            tierClasses: [...document.documentElement.classList]
                .filter(className => className.startsWith('performance-tier-')),
        };
    });
}

async function readGraphicsStyleSnapshot(
    session: IElectronE2ESession,
): Promise<IGraphicsStyleSnapshot> {
    return session.page.evaluate(() => {
        function findScopeAttribute(className: string, propertyName: string) {
            function visitRules(rules: CSSRuleList): string | null {
                for (const rule of rules) {
                    if (rule instanceof CSSStyleRule) {
                        if (
                            !rule.selectorText.includes('html.app-low-graphics')
                            && rule.selectorText.includes(`.${className}`)
                            && rule.style.getPropertyValue(propertyName)
                        ) {
                            return rule.selectorText.match(/\[(data-v-[^\]]+)\]/u)?.[1] ?? null;
                        }
                        continue;
                    }

                    const nestedRules = (rule as CSSRule & {cssRules?: CSSRuleList}).cssRules;
                    if (nestedRules) {
                        const attribute = visitRules(nestedRules);
                        if (attribute) {
                            return attribute;
                        }
                    }
                }
                return null;
            }

            for (const styleSheet of document.styleSheets) {
                try {
                    const attribute = visitRules(styleSheet.cssRules);
                    if (attribute) {
                        return attribute;
                    }
                } catch {
                    // Ignore inaccessible third-party stylesheets; component CSS is same-origin.
                }
            }
            throw new Error(`Scoped component style not found for .${className}`);
        }

        function createScopedFixture(className: string, propertyName: string) {
            const element = document.createElement('div');
            element.className = className;
            element.setAttribute(findScopeAttribute(className, propertyName), '');
            document.body.append(element);
            return element;
        }

        const thumbnailItem = createScopedFixture(
            'document-thumbnail-list__item',
            'will-change',
        );
        const thumbnailPlaceholder = createScopedFixture(
            'document-thumbnail-list__placeholder',
            'animation',
        );
        const djvuBanner = createScopedFixture('djvu-banner', 'backdrop-filter');
        const nativePdfPageNumber = createScopedFixture(
            'native-pdf-page-number',
            'backdrop-filter',
        );

        try {
            return {
                djvuBackdropFilter: getComputedStyle(djvuBanner).backdropFilter,
                nativePdfBackdropFilter: getComputedStyle(nativePdfPageNumber).backdropFilter,
                thumbnailAnimationName: getComputedStyle(thumbnailPlaceholder).animationName,
                thumbnailWillChange: getComputedStyle(thumbnailItem).willChange,
            };
        } finally {
            thumbnailItem.remove();
            thumbnailPlaceholder.remove();
            djvuBanner.remove();
            nativePdfPageNumber.remove();
        }
    });
}

function expectNormalGraphics(snapshot: IGraphicsStyleSnapshot) {
    expect(snapshot).toEqual({
        djvuBackdropFilter: 'blur(8px)',
        nativePdfBackdropFilter: 'blur(6px)',
        thumbnailAnimationName: 'document-thumbnail-pulse',
        thumbnailWillChange: 'transform',
    });
}

function expectLowGraphics(snapshot: IGraphicsStyleSnapshot) {
    expect(snapshot).toEqual({
        djvuBackdropFilter: 'none',
        nativePdfBackdropFilter: 'none',
        thumbnailAnimationName: 'none',
        thumbnailWillChange: 'auto',
    });
}

describe('Electron E2E - Performance Profile Visuals', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('installs the low tier synchronously and disables expensive visuals', async () => {
        session = await startConfiguredElectronE2ESession(
            `e2e-performance-visuals-low-${Date.now()}`,
            'low',
            [],
        );
        await waitForAppReady(session);

        expect(await readRootProfileSnapshot(session)).toEqual({
            appLowGraphics: true,
            profileAccessWasSynchronous: true,
            profileTier: 'low',
            tierClasses: ['performance-tier-low'],
        });
        expectLowGraphics(await readGraphicsStyleSnapshot(session));
    }, E2E_TIMEOUT_MS);

    it('toggles low graphics with reduced motion while preserving medium visuals', async () => {
        session = await startConfiguredElectronE2ESession(
            `e2e-performance-visuals-medium-${Date.now()}`,
            'medium',
            [],
        );
        await waitForAppReady(session);

        expect(await readRootProfileSnapshot(session)).toEqual({
            appLowGraphics: false,
            profileAccessWasSynchronous: true,
            profileTier: 'medium',
            tierClasses: ['performance-tier-medium'],
        });
        expectNormalGraphics(await readGraphicsStyleSnapshot(session));

        const client = await session.page.createCDPSession();
        try {
            await client.send('Emulation.setEmulatedMedia', {features: [{
                name: 'prefers-reduced-motion',
                value: 'reduce',
            }]});
            await session.page.waitForFunction(
                () => document.documentElement.classList.contains('app-low-graphics'),
            );
            expectLowGraphics(await readGraphicsStyleSnapshot(session));

            await client.send('Emulation.setEmulatedMedia', {features: [{
                name: 'prefers-reduced-motion',
                value: 'no-preference',
            }]});
            await session.page.waitForFunction(
                () => !document.documentElement.classList.contains('app-low-graphics'),
            );
            expectNormalGraphics(await readGraphicsStyleSnapshot(session));
        } finally {
            await client.detach();
        }
    }, E2E_TIMEOUT_MS);

    it('keeps high-tier visuals unchanged with exactly one tier class', async () => {
        session = await startConfiguredElectronE2ESession(
            `e2e-performance-visuals-high-${Date.now()}`,
            'high',
            [],
        );
        await waitForAppReady(session);

        expect(await readRootProfileSnapshot(session)).toEqual({
            appLowGraphics: false,
            profileAccessWasSynchronous: true,
            profileTier: 'high',
            tierClasses: ['performance-tier-high'],
        });
        expectNormalGraphics(await readGraphicsStyleSnapshot(session));
    }, E2E_TIMEOUT_MS);
});
