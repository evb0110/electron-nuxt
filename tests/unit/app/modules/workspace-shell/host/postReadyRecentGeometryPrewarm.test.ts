import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IRecentFile } from '@contracts/shared';
import type { IStartupWorkProfile } from '@app/utils/startupWorkProfile';

const mocks = vi.hoisted(() => ({
    begin: vi.fn(),
    settle: vi.fn(),
    pdfPrewarm: vi.fn(),
    djvuPrewarm: vi.fn(),
}));

vi.mock('@app/modules/workspace-shell/host/recentOpenGeometryReadiness', () => ({
    beginRecentOpenGeometryPrewarm: mocks.begin,
    settleRecentOpenGeometryPrewarm: mocks.settle,
}));
vi.mock('@app/modules/pdf-viewer/runtime/lifecycle/prewarmRecentPdfOpeningGeometry', () => ({prewarmRecentPdfOpeningGeometry: mocks.pdfPrewarm}));
vi.mock('@app/modules/djvu-viewer/runtime/djvuTrustedOpenGeometryCache', () => ({prewarmRecentDjvuOpeningGeometry: mocks.djvuPrewarm}));

function createFiles(): IRecentFile[] {
    return Array.from({length: 5}, (_, index) => [
        {
            originalPath: `/files/pdf-${index + 1}.pdf`,
            fileName: `pdf-${index + 1}.pdf`,
            timestamp: index,
        },
        {
            originalPath: `/files/djvu-${index + 1}.djvu`,
            fileName: `djvu-${index + 1}.djvu`,
            timestamp: index,
        },
    ]).flat();
}

function createProfile(
    tier: IStartupWorkProfile['tier'],
    limit: number,
    concurrency: number,
): IStartupWorkProfile {
    return {
        tier,
        desktopViewerWarmupStrategy: tier === 'low' ? 'skip' : tier === 'medium' ? 'staged' : 'eager',
        recentGeometryCandidateLimit: limit,
        recentGeometryConcurrency: concurrency,
    };
}

function installSuccessfulPrewarmMocks() {
    mocks.pdfPrewarm.mockImplementation(async (
        files: IRecentFile[],
        _port: unknown,
        options: {
            limit: number;
            onSettled: (file: IRecentFile, geometry: object) => void;
        },
    ) => {
        const candidates = files.filter(file => file.fileName.endsWith('.pdf')).slice(0, options.limit);
        const results = new Map();
        for (const file of candidates) {
            const geometry = {};
            results.set(file.originalPath, geometry);
            options.onSettled(file, geometry);
        }
        return results;
    });
    mocks.djvuPrewarm.mockImplementation(async (
        files: IRecentFile[],
        _port: unknown,
        options: {
            limit: number;
            onSettled: (file: IRecentFile, geometry: object) => void;
        },
    ) => {
        const candidates = files.filter(file => file.fileName.endsWith('.djvu')).slice(0, options.limit);
        const results = new Map();
        for (const file of candidates) {
            const geometry = {};
            results.set(file.originalPath, geometry);
            options.onSettled(file, geometry);
        }
        return results;
    });
}

describe('runPostReadyRecentGeometryPrewarm', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        installSuccessfulPrewarmMocks();
    });

    it.each([
        [
            'low',
            1,
            1,
        ],
        [
            'medium',
            2,
            1,
        ],
        [
            'high',
            4,
            2,
        ],
    ] as const)('applies the %s profile per engine', async (
        tier,
        limit,
        concurrency,
    ) => {
        const { runPostReadyRecentGeometryPrewarm } = await import(
            '@app/modules/workspace-shell/host/runPostReadyRecentGeometryPrewarm'
        );

        const result = await runPostReadyRecentGeometryPrewarm({
            files: createFiles(),
            ports: {
                readPdfOpeningGeometry: vi.fn(),
                readDjvuSourceInfo: vi.fn(),
            },
            profile: createProfile(tier, limit, concurrency),
        });

        expect(result).toEqual({
            pdfCandidateCount: limit,
            djvuCandidateCount: limit,
            pdfSettledCount: limit,
            djvuSettledCount: limit,
        });
        expect(mocks.pdfPrewarm).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(Object),
            expect.objectContaining({
                concurrency,
                limit,
            }),
        );
        expect(mocks.djvuPrewarm).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(Object),
            expect.objectContaining({
                concurrency,
                limit,
            }),
        );
        expect(mocks.begin).toHaveBeenNthCalledWith(
            1,
            Array.from({length: limit}, (_, index) => `/files/pdf-${index + 1}.pdf`),
        );
        expect(mocks.begin).toHaveBeenNthCalledWith(
            2,
            Array.from({length: limit}, (_, index) => `/files/djvu-${index + 1}.djvu`),
        );
    });

    it('never marks non-selected entries pending', async () => {
        const { runPostReadyRecentGeometryPrewarm } = await import(
            '@app/modules/workspace-shell/host/runPostReadyRecentGeometryPrewarm'
        );

        await runPostReadyRecentGeometryPrewarm({
            files: createFiles(),
            ports: {readDjvuSourceInfo: vi.fn()},
            profile: createProfile('low', 1, 1),
        });

        expect(mocks.begin.mock.calls.flat(2)).not.toContain('/files/pdf-2.pdf');
        expect(mocks.begin.mock.calls.flat(2)).not.toContain('/files/djvu-2.djvu');
    });

    it('settles selected failures as cold fallback and reports them', async () => {
        const failure = new Error('geometry failed');
        mocks.pdfPrewarm.mockRejectedValueOnce(failure);
        mocks.djvuPrewarm.mockResolvedValueOnce(new Map());
        const onError = vi.fn();
        const { runPostReadyRecentGeometryPrewarm } = await import(
            '@app/modules/workspace-shell/host/runPostReadyRecentGeometryPrewarm'
        );

        await runPostReadyRecentGeometryPrewarm({
            files: createFiles(),
            ports: {readDjvuSourceInfo: vi.fn()},
            profile: createProfile('low', 1, 1),
            onError,
        });

        expect(mocks.settle).toHaveBeenCalledWith('/files/pdf-1.pdf', 'cold-fallback');
        expect(mocks.settle).toHaveBeenCalledWith('/files/djvu-1.djvu', 'cold-fallback');
        expect(onError).toHaveBeenCalledWith('pdf', '/files/pdf-1.pdf', failure);
    });

    it('waits for both engine pipelines before resolving', async () => {
        let resolvePdf: ((value: Map<string, null>) => void) | undefined;
        let resolveDjvu: ((value: Map<string, null>) => void) | undefined;
        mocks.pdfPrewarm.mockReturnValueOnce(new Promise((resolve) => {
            resolvePdf = resolve;
        }));
        mocks.djvuPrewarm.mockReturnValueOnce(new Promise((resolve) => {
            resolveDjvu = resolve;
        }));
        const { runPostReadyRecentGeometryPrewarm } = await import(
            '@app/modules/workspace-shell/host/runPostReadyRecentGeometryPrewarm'
        );
        const completion = runPostReadyRecentGeometryPrewarm({
            files: createFiles(),
            ports: {readDjvuSourceInfo: vi.fn()},
            profile: createProfile('low', 1, 1),
        });
        let settled = false;
        void completion.then(() => {
            settled = true;
        });

        resolvePdf?.(new Map());
        await Promise.resolve();
        expect(settled).toBe(false);
        resolveDjvu?.(new Map());

        await completion;
        expect(settled).toBe(true);
    });
});
