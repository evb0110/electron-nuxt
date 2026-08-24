import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';

const APP_SHELL_PATH = join(process.cwd(), 'app/app.vue');
const MAIN_CSS_PATH = join(process.cwd(), 'app/assets/css/main.css');

/**
 * Nuxt UI anchors its toast viewport with `bottom-4` and lets the stack grow
 * upward from there, laying out `height + 16px` per toast. These are the numbers
 * the shell has to keep clear so a scan-cleanup failure toast never lands on top
 * of the runtime diagnostic card.
 */
const TOAST_VIEWPORT_GUTTER_REM = 1;
const TOAST_STACK_GAP_REM = 1;

// The least height at which a scrollable report surface is still something the
// user can read and scroll rather than a sliver. Both the supported-window
// assertions and the floor below are held to it.
const MIN_READABLE_SURFACE_HEIGHT_REM = 4;

// Window heights the desktop shell is expected to stay usable at, in rem at the
// default 16px root size: a 640px-tall laptop window up to a 1440px display.
const SUPPORTED_VIEWPORT_HEIGHTS_REM = [
    40,
    48,
    56.25,
    64,
    90,
];

// Declaration assertions run against a whitespace-normalized copy of the source.
// Where a long `calc()` wraps and how deeply it is indented belong to the
// formatter; the geometry those declarations express is what this test holds.
// The numeric checks further down read the same normalized text, so a reflow
// cannot silently drop a term from the reserve either.
//
// Collapsing runs of whitespace is not enough on its own: a wrapped `calc(`
// leaves a space that an unwrapped one does not have, which would put formatting
// artifacts into the expected strings below. Whitespace just inside a
// parenthesis carries no meaning in CSS, so it is dropped too, and the expected
// declarations read the way they are written.
function normalizeCssWhitespace(source: string) {
    return source
        .replace(/\s+/gu, ' ')
        .replace(/\(\s+/gu, '(')
        .replace(/\s+\)/gu, ')');
}

// The one number the stylesheet is allowed to hold for a runtime-written
// property: the value used when the attribute publishing it is absent entirely.
function readVarFallback(css: string, name: string) {
    const match = new RegExp(`var\\(--${name},\\s*(\\d+)\\)`, 'u').exec(css);
    expect(match, `expected --${name} to be referenced with a numeric var() fallback`).not.toBeNull();
    return Number.parseInt(match![1]!, 10);
}

// Exactly one declaration, for the same reason the stack maximum has exactly one
// source: a second declaration is the copy that drifts, and reading the first of
// two would hold this geometry to a number the cascade may not be using.
function readRemVariable(css: string, name: string) {
    const matches = [...css.matchAll(new RegExp(`--${name}:\\s*([\\d.]+)rem;`, 'gu'))];
    expect(matches, `expected --${name} to be declared exactly once in rem`).toHaveLength(1);
    return Number.parseFloat(matches[0]![1]!);
}

// What the stylesheet's `clamp()` computes to, for a viewport the assertions
// below name. The floor is the operand that decides what happens once the
// reserve exceeds the window and the remainder turns negative.
function clampToReserve(options: {
    floorRem: number;
    maxRem: number;
    remainderRem: number;
}) {
    return Math.max(options.floorRem, Math.min(options.maxRem, options.remainderRem));
}

// The stack maximum has exactly one source: the constant in the shell. The
// toaster is given it as `max`, and the same constant is published onto `<html>`
// as `--app-toast-stack-max` for the reserve below to size itself from. Reading
// it from the shell is therefore reading the value both consumers actually get.
function readConfiguredToastStackMax(shell: string) {
    const declaration = /const APP_TOAST_STACK_MAX = (\d+);/u.exec(shell);
    expect(declaration, 'expected app.vue to declare the toast stack maximum').not.toBeNull();
    // Nuxt UI's own default is 5. The shell has to pass its own maximum, because
    // the reserve below is only an upper bound for the number it passes.
    expect(shell).toContain('max: APP_TOAST_STACK_MAX,');
    expect(
        shell,
        'expected app.vue to publish --app-toast-stack-max from APP_TOAST_STACK_MAX',
    ).toContain('--app-toast-stack-max: ${APP_TOAST_STACK_MAX};');
    return Number.parseInt(declaration![1]!, 10);
}

async function readSources() {
    const [
        shell,
        css,
    ] = await Promise.all([
        readFile(APP_SHELL_PATH, 'utf8'),
        readFile(MAIN_CSS_PATH, 'utf8'),
    ]);
    return {
        css: normalizeCssWhitespace(css),
        shell,
        shellCss: normalizeCssWhitespace(shell),
    };
}

describe('runtime notification surface layout', () => {
    it('anchors the diagnostic card and the toast viewport to opposite edges', async () => {
        const {shell} = await readSources();

        // The toaster position is pinned in the shell rather than inherited, so
        // the separation below cannot be undone by a Nuxt UI default change.
        expect(shell).toContain('<UApp :toaster="toasterOptions">');
        expect(shell).toContain('position: \'bottom-right\' as const,');
        const containerClass = /class="runtime-error-reports ([^"]+)"/u.exec(shell)?.[1] ?? '';
        expect(containerClass.split(/\s+/u)).toContain('top-4');
        expect(containerClass.split(/\s+/u)).not.toContain('bottom-4');
    });

    it('bounds every toast so the stack it can grow to has an upper bound', async () => {
        const {
            css,
            shell,
        } = await readSources();

        // Without a height bound per toast the band below is a guess: Nuxt UI
        // sizes toasts to their content.
        expect(shell).toContain('ui: {base: \'app-toast\'},');
        const rule = /\.app-toast \{([^}]*)\}/u.exec(css)?.[1] ?? '';
        expect(rule, 'expected an .app-toast rule in the stylesheet').not.toBe('');
        expect(rule).toContain('max-height: var(--app-toast-max-height);');
        // Bounded, not truncated: content past the bound stays reachable.
        expect(rule).toContain('overflow-y: auto;');
    });

    it('derives the reserved band from the configured stack maximum', async () => {
        const {
            css,
            shell,
        } = await readSources();

        const configuredMax = readConfiguredToastStackMax(shell);
        // A declaration in the stylesheet would be a second copy of a number the
        // shell already owns, and the copy is what drifts: the reserve would go
        // on describing a stack depth the toaster no longer renders. The only
        // number the stylesheet may carry is the `var()` fallback the repository
        // requires for a runtime-written property, and it has to agree with the
        // constant that is published.
        expect(css, 'expected the stylesheet to consume --app-toast-stack-max, not redeclare it')
            .not.toMatch(/--app-toast-stack-max\s*:/u);
        expect(readVarFallback(css, 'app-toast-stack-max')).toBe(configuredMax);
        expect(readRemVariable(css, 'app-toast-stack-gap')).toBe(TOAST_STACK_GAP_REM);
        expect(css).toContain(
            '--app-runtime-report-toast-band: calc('
            + `var(--app-toast-stack-max, ${configuredMax}) `
            + '* (var(--app-toast-max-height) + var(--app-toast-stack-gap)));',
        );
        expect(css).toContain(
            '--app-runtime-report-notification-reserve: calc(var(--app-runtime-report-toast-band)'
            + ' + var(--app-runtime-report-viewport-gutter));',
        );
    });

    it('never lets the diagnostic card grow into the tallest possible toast stack', async () => {
        const {
            css,
            shell,
            shellCss,
        } = await readSources();

        expect(shellCss).toMatch(
            /\.runtime-error-reports-card\s*\{\s*max-height:\s*clamp\(\s*var\(--app-runtime-report-min-height\),\s*calc\(100vh - var\(--app-runtime-report-notification-reserve\)\),\s*var\(--app-runtime-report-max-height\)\s*\);/u,
        );

        const cardMaxHeightRem = readRemVariable(css, 'app-runtime-report-max-height');
        const minHeightRem = readRemVariable(css, 'app-runtime-report-min-height');
        const viewportGutterRem = readRemVariable(css, 'app-runtime-report-viewport-gutter');
        const toastMaxHeightRem = readRemVariable(css, 'app-toast-max-height');
        const stackMax = readConfiguredToastStackMax(shell);
        // The tallest stack Nuxt UI can render: every slot filled with a toast
        // at its bound, each followed by the layout's 16px gap.
        const toastBandRem = stackMax * (toastMaxHeightRem + TOAST_STACK_GAP_REM);
        const notificationReserveRem = toastBandRem + viewportGutterRem;

        for (const viewportHeightRem of SUPPORTED_VIEWPORT_HEIGHTS_REM) {
            const cardHeightRem = clampToReserve({
                floorRem: minHeightRem,
                maxRem: cardMaxHeightRem,
                remainderRem: viewportHeightRem - notificationReserveRem,
            });
            // Across the supported window heights the reserve still fits, so the
            // floor is not what is keeping the card off the toast band here.
            expect(
                viewportHeightRem - notificationReserveRem,
                `the floor rather than the reserve bounds the card at ${viewportHeightRem}rem viewport height`,
            ).toBeGreaterThanOrEqual(minHeightRem);
            const cardBottomEdgeRem = TOAST_VIEWPORT_GUTTER_REM + cardHeightRem;
            const toastBandTopEdgeRem = viewportHeightRem - TOAST_VIEWPORT_GUTTER_REM - toastBandRem;

            expect(
                cardBottomEdgeRem,
                `runtime report card overlaps the toast band at ${viewportHeightRem}rem viewport height`,
            ).toBeLessThanOrEqual(toastBandTopEdgeRem);
            expect(
                cardHeightRem,
                `runtime report card has no usable height at ${viewportHeightRem}rem viewport height`,
            ).toBeGreaterThan(0);
        }
    });

    it('keeps the expandable detail region inside the same reserve', async () => {
        const {
            css,
            shell,
            shellCss,
        } = await readSources();

        expect(shellCss).toMatch(
            /\.runtime-error-report-details\s*\{\s*max-height:\s*clamp\(\s*var\(--app-runtime-report-min-height\),\s*calc\(100vh - var\(--app-runtime-report-details-reserve\)\),\s*var\(--app-runtime-report-details-max-height\)\s*\);/u,
        );
        expect(css).toContain(
            '--app-runtime-report-details-reserve: calc(var(--app-runtime-report-notification-reserve)'
            + ' + var(--app-runtime-report-details-chrome));',
        );

        const detailsMaxHeightRem = readRemVariable(css, 'app-runtime-report-details-max-height');
        const detailsChromeRem = readRemVariable(css, 'app-runtime-report-details-chrome');
        const minHeightRem = readRemVariable(css, 'app-runtime-report-min-height');
        const viewportGutterRem = readRemVariable(css, 'app-runtime-report-viewport-gutter');
        const toastMaxHeightRem = readRemVariable(css, 'app-toast-max-height');
        const stackMax = readConfiguredToastStackMax(shell);
        const detailsReserveRem = stackMax * (toastMaxHeightRem + TOAST_STACK_GAP_REM)
            + viewportGutterRem
            + detailsChromeRem;

        for (const viewportHeightRem of SUPPORTED_VIEWPORT_HEIGHTS_REM) {
            const detailsHeightRem = clampToReserve({
                floorRem: minHeightRem,
                maxRem: detailsMaxHeightRem,
                remainderRem: viewportHeightRem - detailsReserveRem,
            });
            // The details list scrolls, so it only has to stay readable rather
            // than fit whole. Nothing is hidden that scrolling cannot reach.
            expect(
                detailsHeightRem,
                `runtime report details collapse to nothing at ${viewportHeightRem}rem viewport height`,
            ).toBeGreaterThanOrEqual(MIN_READABLE_SURFACE_HEIGHT_REM);
        }
    });

    // Nothing pins the window to the supported range: the shell can be dragged
    // shorter than the reserve, and there the remainder both surfaces are bounded
    // to is negative. CSS clamps a negative `max-height` to zero, so without a
    // floor the runtime report would vanish on exactly the windows where a
    // failure is hardest to see.
    it('floors both surfaces on a window shorter than the reserve', async () => {
        const {
            css,
            shell,
        } = await readSources();

        const minHeightRem = readRemVariable(css, 'app-runtime-report-min-height');
        const cardMaxHeightRem = readRemVariable(css, 'app-runtime-report-max-height');
        const detailsMaxHeightRem = readRemVariable(css, 'app-runtime-report-details-max-height');
        const detailsChromeRem = readRemVariable(css, 'app-runtime-report-details-chrome');
        const viewportGutterRem = readRemVariable(css, 'app-runtime-report-viewport-gutter');
        const toastMaxHeightRem = readRemVariable(css, 'app-toast-max-height');
        const stackMax = readConfiguredToastStackMax(shell);
        const notificationReserveRem = stackMax * (toastMaxHeightRem + TOAST_STACK_GAP_REM)
            + viewportGutterRem;
        const detailsReserveRem = notificationReserveRem + detailsChromeRem;
        // A 384px-tall window: shorter than either reserve, so both remainders
        // are negative and the floor is the only operand left holding a height.
        const shortViewportHeightRem = 24;

        expect(shortViewportHeightRem - notificationReserveRem).toBeLessThan(0);
        expect(shortViewportHeightRem - detailsReserveRem).toBeLessThan(0);
        expect(clampToReserve({
            floorRem: minHeightRem,
            maxRem: cardMaxHeightRem,
            remainderRem: shortViewportHeightRem - notificationReserveRem,
        })).toBe(minHeightRem);
        expect(clampToReserve({
            floorRem: minHeightRem,
            maxRem: detailsMaxHeightRem,
            remainderRem: shortViewportHeightRem - detailsReserveRem,
        })).toBe(minHeightRem);
        expect(minHeightRem).toBeGreaterThanOrEqual(MIN_READABLE_SURFACE_HEIGHT_REM);
        // And low enough that it never becomes the bound on a window the shell is
        // sized for, where staying clear of the toast band is what decides the
        // height.
        expect(minHeightRem).toBeLessThan(
            Math.min(...SUPPORTED_VIEWPORT_HEIGHTS_REM) - detailsReserveRem,
        );
    });
});
