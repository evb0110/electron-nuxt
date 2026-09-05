// @vitest-environment happy-dom
import type { Page } from 'puppeteer-core';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    clickRendererPrintSubmit,
    createPuppeteerViewerDriver,
} from '@scripts/windows-test/guest/viewer/createPuppeteerViewerDriver';

vi.mock('@tests/e2e/electron/helpers/fixtures', () => ({readPdfAnnotationSummary: vi.fn()}));

interface IPrintPageOptions {printSubmitStates?: string[];}

function createPrintPage(options: IPrintPageOptions = {}) {
    const printSubmitStates = [...(options.printSubmitStates ?? ['clicked'])];
    const commandNames: string[] = [];
    const evaluateCalls: unknown[] = [];
    const evaluate = vi.fn(async (expression: unknown, payload?: unknown) => {
        evaluateCalls.push({
            expression,
            payload,
        });
        if (typeof expression === 'function') {
            const commandName = (payload as {commandName?: string} | undefined)?.commandName;
            if (commandName) {
                commandNames.push(commandName);
            }
            return {
                called: true,
                value: null,
            };
        }

        const source = String(expression);
        if (source.includes('i-ph-printer')) {
            return printSubmitStates.shift() ?? 'clicked';
        }
        return undefined;
    });
    const page = Object.create(null) as Page;
    Object.defineProperties(page, {
        evaluate: {value: evaluate},
        on: {value: vi.fn()},
    });

    return {
        commandNames,
        evaluateCalls,
        page,
    };
}

function createDomPage() {
    const evaluate = vi.fn(async (expression: unknown) => {
        if (typeof expression !== 'string') {
            throw new Error('the DOM page test only accepts serialized page expressions');
        }
        return Function(`return ${expression}`)();
    });
    const page = Object.create(null) as Page;
    Object.defineProperty(page, 'evaluate', {value: evaluate});
    return page;
}

function giveElementGeometry(element: HTMLElement) {
    Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
            bottom: 40,
            height: 40,
            left: 0,
            right: 100,
            top: 0,
            width: 100,
        }),
    });
}

describe('Puppeteer viewer print command', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('submits the renderer print dialog before native dialog handling', async () => {
        const harness = createPrintPage();

        await createPuppeteerViewerDriver(harness.page).printDocumentCommand();

        expect(harness.commandNames).toEqual(['handlePrint']);
        expect(harness.evaluateCalls.some((call) => (
            typeof (call as {expression?: unknown}).expression === 'string'
            && String((call as {expression: unknown}).expression).includes('i-ph-printer')
        ))).toBe(true);
    });

    it('fails closed when more than one visible renderer print submit button matches', async () => {
        const harness = createPrintPage({printSubmitStates: ['ambiguous']});

        await expect(clickRendererPrintSubmit(harness.page, 0))
            .rejects
            .toThrow('multiple visible submit buttons');
    });

    it('reports a missing renderer submit button instead of invoking a native shortcut', async () => {
        const harness = createPrintPage({printSubmitStates: ['not-found']});

        await expect(clickRendererPrintSubmit(harness.page, 0))
            .rejects
            .toThrow('Timed out waiting for the renderer print dialog submit button');
        expect(harness.commandNames).toHaveLength(0);
    });

    it('clicks the observed colon-delimited Phosphor icon in the dialog footer', async () => {
        document.body.innerHTML = `
            <div role="dialog" data-state="open">
                <div data-slot="footer">
                    <button type="button">
                        <span class="iconify i-ph:printer size-4 shrink-0"></span>
                        <span>Print...</span>
                    </button>
                </div>
            </div>
        `;
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        const button = dialog?.querySelector<HTMLButtonElement>('button');
        if (!dialog || !button) {
            throw new Error('the print dialog fixture did not mount');
        }
        giveElementGeometry(dialog);
        giveElementGeometry(button);
        let clickCount = 0;
        button.addEventListener('click', () => {
            clickCount += 1;
        });

        await clickRendererPrintSubmit(createDomPage(), 0);

        expect(clickCount).toBe(1);
    });
});
