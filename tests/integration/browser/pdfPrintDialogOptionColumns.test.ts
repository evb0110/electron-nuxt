import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import {
    describe,
    expect,
    it,
} from 'vitest';
import buttonTheme from '#build/ui/button';
import { LOCALE_MESSAGES } from '@i18n-app';
import { compileAppStylesheet } from '@tests/helpers/compileAppStylesheet';

const BROWSER_TEST_TIMEOUT_MS = 120_000;
// The print dialog's body as the app really lays it out: the modal is narrow, so
// the two option columns share a container this wide and each `1fr` track is
// about 209px. A wider container would hide the overflow this test is about.
const DIALOG_BODY_WIDTH_PX = 434;
const PRINT_DIALOG_PATH = new URL(
    '../../../app/modules/pdf-viewer/components/PdfPrintDialog.vue',
    import.meta.url,
);
const OPTION_BUTTON_CLASS_PATTERN = /const optionButtonClass = '([^']+)';/u;
const OPTION_GRID_CLASS_PATTERN = /<div class="(grid gap-4[^"]*)">/u;
const OPTION_COLUMN_CLASS_PATTERN = /<div class="(flex [^"]*flex-col[^"]*)">/u;
const OPTION_BUTTON_ELEMENT_PATTERN = /<UButton\s+v-for="option in (?:layout|orientation)Options"[\s\S]*?<\/UButton>/gu;

interface IOptionColumnMarkup {
    buttonClass: string;
    columnClass: string;
    gridClass: string;
}

interface IColumnSpec extends IOptionColumnMarkup {
    headings: string[];
    labelColumns: string[][];
    truncatingLabelSlotClass: string | null;
}

/**
 * Reads the classes the component itself puts on its option columns instead of
 * restating them here, so a change to the component is measured rather than
 * silently tested against a stale copy.
 */
async function readOptionColumnMarkup() {
    const source = await readFile(PRINT_DIALOG_PATH, 'utf8');
    const buttonClass = OPTION_BUTTON_CLASS_PATTERN.exec(source)?.[1];
    const gridMatch = OPTION_GRID_CLASS_PATTERN.exec(source);
    const gridClass = gridMatch?.[1];
    const columnClass = gridMatch
        ? OPTION_COLUMN_CLASS_PATTERN.exec(source.slice(gridMatch.index))?.[1]
        : undefined;

    if (!buttonClass || !gridClass || !columnClass) {
        throw new Error('PdfPrintDialog.vue no longer exposes its option column classes in the shape this test reads');
    }

    return {
        buttonClass,
        columnClass,
        gridClass,
    };
}

function printLabelsFor(locale: keyof typeof LOCALE_MESSAGES) {
    const {print} = LOCALE_MESSAGES[locale];
    return {
        headings: [
            print.layoutLabel,
            print.orientationLabel,
        ],
        labelColumns: [
            [
                print.layoutSingle,
                print.layoutFacing,
                print.layoutFacingFirstSingle,
            ],
            [
                print.orientationAuto,
                print.orientationPortrait,
                print.orientationLandscape,
            ],
        ],
    };
}

function buildPageMarkup(appStylesheet: string) {
    return `<!doctype html>
<html>
<head><style>${appStylesheet}</style></head>
<body style="margin: 0">
<div id="host" style="width: ${String(DIALOG_BODY_WIDTH_PX)}px"></div>
</body>
</html>`;
}

/**
 * Rebuilds the option columns in Chromium and reports where the layout column's
 * buttons actually land relative to the orientation column beside them.
 */
function renderAndMeasureColumns(spec: IColumnSpec) {
    const host = document.querySelector('#host');
    if (!(host instanceof HTMLElement)) {
        throw new Error('Layout page lost its host element');
    }

    const grid = document.createElement('div');
    grid.className = spec.gridClass;
    const optionGroups = spec.labelColumns.map((labels, columnIndex) => {
        const column = document.createElement('div');
        column.className = spec.columnClass;
        const heading = document.createElement('p');
        heading.className = 'm-0 text-xs text-muted';
        heading.textContent = spec.headings[columnIndex] ?? '';
        const options = document.createElement('div');
        options.className = 'grid gap-2';
        for (const label of labels) {
            const button = document.createElement('button');
            button.className = spec.buttonClass;
            if (spec.truncatingLabelSlotClass === null) {
                button.textContent = label;
            } else {
                const labelSlot = document.createElement('span');
                labelSlot.className = spec.truncatingLabelSlotClass;
                labelSlot.textContent = label;
                button.append(labelSlot);
            }
            options.append(button);
        }
        column.append(heading, options);
        grid.append(column);
        return options;
    });
    host.replaceChildren(grid);

    const [
        layoutOptions,
        orientationOptions,
    ] = optionGroups;
    if (!layoutOptions || !orientationOptions) {
        throw new Error('Rendered print options are missing one of their two columns');
    }
    const buttons = [...layoutOptions.children].filter((child): child is HTMLElement =>
        child instanceof HTMLElement);
    const rects = buttons.map(button => button.getBoundingClientRect());
    const rightmostEdgePx = Math.max(...rects.map(rect => rect.right));

    return {
        buttonHeightsPx: rects.map(rect => rect.height),
        clippedLabels: buttons
            .filter(button => button.scrollWidth > button.clientWidth + 1)
            .map(button => button.textContent ?? ''),
        columnOverlapPx: rightmostEdgePx - orientationOptions.getBoundingClientRect().left,
        escapesGridPx: Math.max(0, rightmostEdgePx - grid.getBoundingClientRect().right),
        textAligns: buttons.map(button => globalThis.getComputedStyle(button).textAlign),
    };
}

describe('print dialog option columns in Chromium', () => {
    it('keeps every locale\'s option buttons inside their own column', async () => {
        const markup = await readOptionColumnMarkup();
        // The button geometry Nuxt UI's own theme applies, at the size `UButton`
        // defaults to, plus the `truncate` its label slot carries.
        const {size} = buttonTheme.variants;
        const nuxtUiButtonClass = [
            buttonTheme.slots.base,
            size[buttonTheme.defaultVariants.size].base,
        ].flat().join(' ');
        const labelSlotClass = buttonTheme.slots.label;

        expect(labelSlotClass).toContain('truncate');

        const browser = await chromium.launch({headless: true});
        try {
            const page = await browser.newPage();
            const buttonClass = `${nuxtUiButtonClass} ${markup.buttonClass}`;
            await page.setContent(buildPageMarkup(await compileAppStylesheet([
                ...`${buttonClass} ${labelSlotClass} ${markup.columnClass} ${markup.gridClass}`.split(' '),
                'grid',
                'gap-2',
                'm-0',
                'text-xs',
                'text-muted',
            ])));

            for (const locale of Object.keys(LOCALE_MESSAGES) as Array<keyof typeof LOCALE_MESSAGES>) {
                const geometry = await page.evaluate(renderAndMeasureColumns, {
                    ...markup,
                    ...printLabelsFor(locale),
                    buttonClass,
                    truncatingLabelSlotClass: null,
                });

                // A button that reaches past the orientation column's left edge is
                // the reported defect: the long option names painted over the
                // controls next to them.
                expect({
                    locale,
                    overlaps: geometry.columnOverlapPx > 0,
                }).toStrictEqual({
                    locale,
                    overlaps: false,
                });
                expect({
                    locale,
                    clippedLabels: geometry.clippedLabels,
                    escapesGridPx: geometry.escapesGridPx,
                }).toStrictEqual({
                    locale,
                    clippedLabels: [],
                    escapesGridPx: 0,
                });
                // Wrapped option names read as text, not as centred fragments.
                expect(new Set(geometry.textAligns)).toStrictEqual(new Set(['start']));
                expect(geometry.buttonHeightsPx.every(height => height > 0)).toBe(true);
            }

            // The longest option name of them all wraps onto another line inside
            // its own button rather than staying on one line and escaping.
            const russian = await page.evaluate(renderAndMeasureColumns, {
                ...markup,
                ...printLabelsFor('ru'),
                buttonClass,
                truncatingLabelSlotClass: null,
            });
            const [shortestOption] = russian.buttonHeightsPx;
            expect(Math.max(...russian.buttonHeightsPx)).toBeGreaterThan(shortestOption ?? 0);

            // A locale is free to name an option with one unbroken compound
            // word, which a grid item's automatic minimum size would otherwise
            // measure in full. None of the shipped locales does yet; the classes
            // have to hold when one does.
            const german = printLabelsFor('de');
            const compound = await page.evaluate(renderAndMeasureColumns, {
                ...markup,
                ...german,
                buttonClass,
                labelColumns: [
                    [
                        ...german.labelColumns[0]!.slice(0, 2),
                        'Doppelseitenmitersterseiteeinzelndargestellt',
                    ],
                    german.labelColumns[1]!,
                ],
                truncatingLabelSlotClass: null,
            });

            expect(compound.columnOverlapPx).toBeLessThan(0);
            expect(compound.escapesGridPx).toBe(0);

            // The shape this component used before: the theme's truncating label
            // slot, whose `nowrap` makes the button as wide as the whole option
            // name. It still overflows, which is what proves the measurement above
            // would catch a regression rather than passing on anything at all.
            const truncated = await page.evaluate(renderAndMeasureColumns, {
                ...markup,
                ...printLabelsFor('ru'),
                buttonClass: `${nuxtUiButtonClass} justify-start`,
                truncatingLabelSlotClass: labelSlotClass,
            });
            expect(truncated.columnOverlapPx).toBeGreaterThan(0);
        } finally {
            await browser.close();
        }
    }, BROWSER_TEST_TIMEOUT_MS);

    it('renders option names through the default slot so they can wrap', async () => {
        const source = await readFile(PRINT_DIALOG_PATH, 'utf8');
        const optionButtons = [...source.matchAll(OPTION_BUTTON_ELEMENT_PATTERN)].map(match => match[0]);

        expect(optionButtons).toHaveLength(2);
        for (const optionButton of optionButtons) {
            expect(optionButton).toContain('{{ option.label }}');
            // `:label` would route the option name through the theme's truncating
            // label slot again, which is exactly the overflow this component fixes.
            expect(optionButton).not.toContain(':label=');
        }
    });
});
