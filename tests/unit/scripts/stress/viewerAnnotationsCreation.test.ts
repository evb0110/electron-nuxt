import type {Page} from 'puppeteer-core';
import type * as TViewerCore from '@tests/e2e/electron/helpers/viewerCore';
import type * as TViewerDom from '@tests/e2e/electron/helpers/viewerDom';
import type * as TWorkspaceExpose from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {createFreeTextAnnotationWithPointer} from '@tests/e2e/electron/helpers/viewerAnnotations';

const mocks = vi.hoisted(() => ({
    callWorkspaceCommand: vi.fn(),
    findVisiblePointInActiveHost: vi.fn(),
    installWorkspaceExposeProbe: vi.fn(async () => undefined),
    openAnnotationsTab: vi.fn(async () => undefined),
    waitForViewerInteractive: vi.fn(),
}));

vi.mock('@tests/e2e/electron/helpers/viewerCore', async importOriginal => ({
    ...await importOriginal<typeof TViewerCore>(),
    openAnnotationsTab: mocks.openAnnotationsTab,
    waitForViewerInteractive: mocks.waitForViewerInteractive,
}));
vi.mock('@tests/e2e/electron/helpers/viewerDom', async importOriginal => ({
    ...await importOriginal<typeof TViewerDom>(),
    findVisiblePointInActiveHost: mocks.findVisiblePointInActiveHost,
}));
vi.mock('@tests/e2e/electron/helpers/workspaceExpose', async importOriginal => ({
    ...await importOriginal<typeof TWorkspaceExpose>(),
    callWorkspaceCommand: mocks.callWorkspaceCommand,
    installWorkspaceExposeProbe: mocks.installWorkspaceExposeProbe,
}));

afterEach(() => {
    vi.restoreAllMocks();
});

describe('free text stress creation', () => {
    it('activates the visible Text tool and bounds each pointer wait', async () => {
        const waitOptions: Array<{timeout?: number}> = [];
        const waitArguments: unknown[][] = [];
        let evaluateCount = 0;
        const toolbarPoint = {
            x: 20,
            y: 30,
        };
        const pagePoint = {
            x: 120,
            y: 140,
        };
        const disposeEditorHandle = vi.fn(async () => undefined);
        mocks.findVisiblePointInActiveHost.mockResolvedValue(toolbarPoint);

        const fakePage = Object.assign(Object.create(null) as Page, {
            evaluate: vi.fn(async () => {
                evaluateCount += 1;
                if (evaluateCount === 1) {
                    return 'select';
                }
                if (evaluateCount === 2) {
                    return {
                        ...pagePoint,
                        existingEditorIds: [],
                    };
                }
                return 1;
            }),
            keyboard: {
                press: vi.fn(async () => undefined),
                type: vi.fn(async () => undefined),
            },
            mouse: {click: vi.fn(async () => undefined)},
            waitForFunction: vi.fn(async (predicate: (args: unknown) => boolean, options: {timeout?: number}, ...args: unknown[]) => {
                waitOptions.push(options);
                waitArguments.push(args);
                if (waitOptions.length === 3) {
                    return {
                        dispose: disposeEditorHandle,
                        jsonValue: vi.fn(async () => 'free-text-editor-created'),
                    };
                }
                if (waitOptions.length === 4) {
                    const createdEditor = {
                        id: 'free-text-editor-created',
                        querySelector: () => ({textContent: 'stress note 1'}),
                        textContent: 'stress note 1',
                    };
                    const laterEditor = {
                        id: 'free-text-editor-later',
                        querySelector: () => ({textContent: 'later note'}),
                        textContent: 'later note',
                    };
                    const pageRoot = {querySelectorAll: () => [
                        createdEditor,
                        laterEditor,
                    ]};
                    const host = {
                        querySelector: () => pageRoot,
                        querySelectorAll: () => pageRoot.querySelectorAll(),
                    };
                    vi.stubGlobal('__evbE2E', {getActiveWorkspaceHost: () => host});
                    expect(predicate(args[0])).toBe(true);
                }
                return undefined;
            }),
        });

        const result = await createFreeTextAnnotationWithPointer(fakePage, 'stress note 1', {
            x: 0.4,
            y: 0.3,
        }, 2, 6_000);

        expect(result).toBe(1);
        expect(mocks.findVisiblePointInActiveHost).toHaveBeenCalledWith(
            fakePage,
            '.notes-panel .tool-button[data-tool="text"]',
        );
        expect(fakePage.mouse.click).toHaveBeenNthCalledWith(1, toolbarPoint.x, toolbarPoint.y);
        expect(fakePage.mouse.click).toHaveBeenNthCalledWith(2, pagePoint.x, pagePoint.y);
        expect(waitOptions).toHaveLength(4);
        expect(waitOptions.every(options => options.timeout === 6_000)).toBe(true);
        expect(waitArguments[2]).toEqual([{
            existingEditorIds: [],
            targetPageNumber: 2,
        }]);
        expect(waitArguments[3]).toEqual([{
            editorId: 'free-text-editor-created',
            expectedText: 'stress note 1',
            targetPageNumber: 2,
        }]);
        expect(disposeEditorHandle).toHaveBeenCalledOnce();
        expect(fakePage.keyboard.type).toHaveBeenCalledWith('stress note 1', {delay: 10});
        expect(fakePage.keyboard.press).toHaveBeenCalledWith('Escape');
    });
});
