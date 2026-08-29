import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import type {IPdfPageLabelRange} from '@contracts/pdfPageLabels';
import {createCompactPageLabelsFixturePdf} from '@tests/e2e/electron/helpers/fixtures';
import {
    startElectronE2ESession,
    type IElectronE2ESession,
} from '@tests/e2e/electron/helpers/startElectronE2ESession';
import {
    callWorkspaceCommand,
    readWorkspaceStateValues,
    waitForSaveFrontierReady,
} from '@tests/e2e/electron/helpers/workspaceExpose';
import {
    waitForPdfLoaded,
    waitForViewerInteractive,
} from '@tests/e2e/electron/helpers/viewerCore';

const PAGE_COUNT = 201;
const TEST_TIMEOUT_MS = 10 * 60 * 1_000;

const initialRanges: IPdfPageLabelRange[] = [
    {
        startPage: 1,
        style: 'r',
        prefix: '',
        startNumber: 1,
    },
    {
        startPage: 41,
        style: 'D',
        prefix: 'Main-',
        startNumber: 1,
    },
    {
        startPage: 101,
        style: 'R',
        prefix: '',
        startNumber: 1,
    },
    {
        startPage: 151,
        style: 'a',
        prefix: 'Appendix-',
        startNumber: 1,
    },
];

function toRoman(value: number) {
    const parts: Array<[number, string]> = [
        [
            1000,
            'M',
        ],
        [
            900,
            'CM',
        ],
        [
            500,
            'D',
        ],
        [
            400,
            'CD',
        ],
        [
            100,
            'C',
        ],
        [
            90,
            'XC',
        ],
        [
            50,
            'L',
        ],
        [
            40,
            'XL',
        ],
        [
            10,
            'X',
        ],
        [
            9,
            'IX',
        ],
        [
            5,
            'V',
        ],
        [
            4,
            'IV',
        ],
        [
            1,
            'I',
        ],
    ];
    let remaining = value;
    let result = '';
    for (const [
        unit,
        symbol,
    ] of parts) {
        while (remaining >= unit) {
            result += symbol;
            remaining -= unit;
        }
    }
    return result;
}

function toAlpha(value: number) {
    let remaining = value;
    let result = '';
    while (remaining > 0) {
        remaining -= 1;
        result = String.fromCharCode(65 + (remaining % 26)) + result;
        remaining = Math.floor(remaining / 26);
    }
    return result;
}

function labelForPage(page: number, ranges: readonly IPdfPageLabelRange[]) {
    const range = ranges.reduce((current, candidate) => (
        candidate.startPage <= page ? candidate : current
    ));
    const number = range.startNumber + page - range.startPage;
    const value = range.style === 'r'
        ? toRoman(number).toLowerCase()
        : range.style === 'R'
            ? toRoman(number)
            : range.style === 'a'
                ? toAlpha(number).toLowerCase()
                : range.style === 'A'
                    ? toAlpha(number)
                    : String(number);
    return `${range.prefix}${value}`;
}

function labelsFromRanges(totalPages: number, ranges: readonly IPdfPageLabelRange[]) {
    return Array.from({length: totalPages}, (_, index) => labelForPage(index + 1, ranges));
}

async function waitForLabels(session: IElectronE2ESession, expected: readonly string[]) {
    await expect.poll(async () => {
        const state = await readWorkspaceStateValues<{
            pageLabels?: string[] | null;
            pageLabelRanges?: IPdfPageLabelRange[];
            pageLabelsResolved?: boolean;
        }>(session.page, [
            'pageLabels',
            'pageLabelRanges',
            'pageLabelsResolved',
        ]);
        if (state.pageLabelsResolved !== true || state.pageLabels !== null) {
            return null;
        }
        const ranges = state.pageLabelRanges ?? [];
        return labelsFromRanges(expected.length, ranges);
    }, {timeout: 60_000}).toEqual(expected);
}

async function runCommand<T>(session: IElectronE2ESession, name: string, args: unknown[]) {
    const result = await callWorkspaceCommand<T>(session.page, name, args);
    expect(result.called, `${name} should be exposed`).toBe(true);
    return result.value;
}

describe('Electron E2E, compact page labels through structural operations', () => {
    let session: IElectronE2ESession | null = null;

    afterEach(async () => {
        await session?.stop();
        session = null;
    });

    it('keeps every compact label through mutations, save, and reopen', async () => {
        const pdfPath = await createCompactPageLabelsFixturePdf(
            `compact-page-labels-${Date.now()}.pdf`,
            PAGE_COUNT,
        );
        let expected = labelsFromRanges(PAGE_COUNT, initialRanges);
        session = await startElectronE2ESession(`e2e-compact-page-labels-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await waitForSaveFrontierReady(session.page, 60_000);
        await waitForLabels(session, expected);

        expect(await runCommand(session, 'handlePageRotate', [
            [1],
            90,
        ])).toBe(true);
        await waitForLabels(session, expected);

        expect(await runCommand(session, 'pageOpsDelete', [
            [20],
            PAGE_COUNT,
        ])).toBe(true);
        expected = expected.filter((_, index) => index !== 19);
        await waitForLabels(session, expected);

        const reorder = Array.from({length: expected.length}, (_, index) => index + 1);
        [
            reorder[29],
            reorder[30],
        ] = [
            reorder[30]!,
            reorder[29]!,
        ];
        expected = reorder.map(page => expected[page - 1]!);
        expect(await runCommand(session, 'pageOpsReorder', [reorder])).toBe(true);
        await waitForLabels(session, expected);

        expect(await runCommand(session, 'handleCropPages', [
            [40],
            {
                top: 5,
                bottom: 5,
                left: 5,
                right: 5,
            },
        ])).toBe(true);
        await waitForLabels(session, expected);

        const move = {
            pageCount: expected.length,
            startPage: 50,
            endPage: 50,
            insertAt: 120,
        };
        const moved = expected.splice(move.startPage - 1, 1)[0]!;
        expected.splice(move.insertAt - 1, 0, moved);
        expect(await runCommand(session, 'pageOpsMove', [move])).toBe(true);
        await waitForLabels(session, expected);

        expect(await runCommand(session, 'pageOpsInsert', [
            expected.length,
            100,
        ])).toBe(true);
        expected.splice(100, 0, '1');
        await waitForLabels(session, expected);

        expect(await runCommand(session, 'handleSave', [])).toBe(true);
        await expect.poll(async () => (
            await readWorkspaceStateValues<{dirtyState?: {fileDirty?: boolean}}>(session!.page, ['dirtyState'])
        ).dirtyState?.fileDirty, {timeout: 60_000}).toBe(false);

        const savedSession = session;
        session = null;
        await savedSession.stop();
        session = await startElectronE2ESession(`e2e-compact-page-labels-reopen-${Date.now()}`, {
            clean: true,
            extraEnv: {EVB_PDF_PAGE_OPS_ENABLE: '1'},
            initialOpenPaths: [pdfPath],
        });
        await waitForPdfLoaded(session.page, 60_000);
        await waitForViewerInteractive(session.page, 60_000);
        await waitForLabels(session, expected);
    }, TEST_TIMEOUT_MS);
});
