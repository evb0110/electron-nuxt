import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

type TMockListener = (...args: unknown[]) => void;

const mocks = vi.hoisted(() => {
    class MockEmitter {
        private readonly listeners = new Map<string, Set<TMockListener>>();

        on(event: string, listener: TMockListener) {
            const eventListeners = this.listeners.get(event) ?? new Set<TMockListener>();
            eventListeners.add(listener);
            this.listeners.set(event, eventListeners);
            return this;
        }

        emit(event: string, ...args: unknown[]) {
            for (const listener of this.listeners.get(event) ?? []) {
                listener(...args);
            }
        }
    }

    class MockProcess extends MockEmitter {
        readonly stdout = new MockEmitter();

        readonly stderr = new MockEmitter();

        readonly pid: number;

        readonly kill = vi.fn();

        constructor(pid: number) {
            super();
            this.pid = pid;
        }

        close(code: number | null = 0) {
            this.emit('close', code);
        }
    }

    interface ISpawnCall {
        command: string;
        args: string[];
        proc: MockProcess;
    }
    type TSpawnMode = 'success' | 'fail-ranges' | 'hang-ranges' | 'hang-registered';

    const spawnCalls: ISpawnCall[] = [];
    let spawnMode: TSpawnMode = 'success';
    let nextPid = 1000;

    function isRangeDdjvuCall(command: string, args: string[]) {
        return command === '/tools/ddjvu' && args.some(arg => arg.startsWith('-page='));
    }

    function isRegisteredCombineCall(command: string) {
        return command === '/tools/evb-pdf-image-combine';
    }

    const spawn = vi.fn((command: string, args: string[]) => {
        const proc = new MockProcess(nextPid++);
        const call = {
            command,
            args,
            proc,
        };
        spawnCalls.push(call);

        queueMicrotask(() => {
            if (spawnMode === 'hang-ranges' && isRangeDdjvuCall(command, args)) {
                return;
            }
            if (spawnMode === 'hang-registered' && isRegisteredCombineCall(command)) {
                return;
            }
            if (spawnMode === 'fail-ranges' && isRangeDdjvuCall(command, args)) {
                proc.stderr.emit('data', Buffer.from('range conversion failed'));
                proc.close(1);
                return;
            }
            proc.close(0);
        });

        return proc;
    });

    return {
        spawn,
        spawnCalls,
        setSpawnMode: (mode: TSpawnMode) => {
            spawnMode = mode;
        },
        mkdtemp: vi.fn(async () => '/tmp/djvu-pages-test'),
        readFile: vi.fn(),
        rm: vi.fn(async () => undefined),
        stat: vi.fn(async () => ({size: 4096})),
        unlink: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => undefined),
        existsSync: vi.fn(() => true),
        terminateDetachedChildProcess: vi.fn(async (proc: MockProcess) => {
            proc.close(143);
        }),
        loggerWarn: vi.fn(),
    };
});

vi.mock('child_process', () => ({spawn: mocks.spawn}));
vi.mock('fs', () => ({existsSync: mocks.existsSync}));
vi.mock('fs/promises', () => ({
    mkdtemp: mocks.mkdtemp,
    readFile: mocks.readFile,
    rm: mocks.rm,
    stat: mocks.stat,
    unlink: mocks.unlink,
    writeFile: mocks.writeFile,
}));
vi.mock('os', () => ({
    availableParallelism: () => 5,
    cpus: () => Array.from({length: 5}, () => ({})),
    tmpdir: () => '/tmp',
}));
vi.mock('@electron/djvu/paths', () => ({buildDjvuRuntimeEnv: () => ({PATH: '/bin'})}));
vi.mock('@electron/djvu/nativeToolPaths', () => ({getDjvuNativeToolPaths: () => ({
    ddjvu: '/tools/ddjvu',
    djvused: '/tools/djvused',
})}));
vi.mock('@electron/pdf/nativeToolPaths', () => ({getPdfNativeToolPaths: () => ({qpdf: '/tools/qpdf'})}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: mocks.loggerWarn,
})}));
vi.mock('@electron/utils/nativeChildProcess', () => ({
    createDetachedChildProcessSpawnOptions: (options: unknown) => options,
    terminateDetachedChildProcess: mocks.terminateDetachedChildProcess,
}));

const {
    cancelConversion,
    convertDjvuToPdfFile,
    renderDjvuPageToImage,
    runRegisteredDjvuProcess,
} = await import('@electron/features/djvu/main/ddjvuConversion');

describe('convertDjvuToPdfFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.spawnCalls.length = 0;
        mocks.setSpawnMode('success');
    });

    it('splits large full-document conversions into parallel native page ranges', async () => {
        const progress = vi.fn();

        const result = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-1', {
            pageCount: 25,
            onProgress: progress,
        });

        expect(result).toEqual({
            success: true,
            outputPath: '/output.pdf',
            fileSize: 4096,
        });
        const ddjvuCalls = mocks.spawnCalls.filter(call => call.command === '/tools/ddjvu');
        expect(ddjvuCalls.map(call => call.args.find(arg => arg.startsWith('-page=')))).toEqual([
            '-page=1-7',
            '-page=8-13',
            '-page=14-19',
            '-page=20-25',
        ]);
        expect(mocks.spawnCalls.at(-1)).toMatchObject({
            command: '/tools/qpdf',
            args: [
                '--empty',
                '--pages',
                '/tmp/djvu-pages-test/pages-1-7.pdf',
                '/tmp/djvu-pages-test/pages-8-13.pdf',
                '/tmp/djvu-pages-test/pages-14-19.pdf',
                '/tmp/djvu-pages-test/pages-20-25.pdf',
                '--',
                '/output.pdf',
            ],
        });
        expect(progress).toHaveBeenLastCalledWith(95);
        expect(mocks.rm).toHaveBeenCalledWith('/tmp/djvu-pages-test', {
            recursive: true,
            force: true,
        });
    });

    it('keeps small conversions on the single native process path', async () => {
        await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-2', {pageCount: 4});

        expect(mocks.spawnCalls).toHaveLength(1);
        expect(mocks.spawnCalls[0]).toMatchObject({
            command: '/tools/ddjvu',
            args: [
                '-format=pdf',
                '-verbose',
                '/input.djvu',
                '/output.pdf',
            ],
        });
    });

    it('renders requested DjVu page modes through registered ddjvu processes', async () => {
        const result = await renderDjvuPageToImage('/input.djvu', '/mask.pbm', 7, 'job-mask', {
            format: 'pbm',
            mode: 'mask',
        });

        expect(result).toEqual({
            success: true,
            outputPath: '/mask.pbm',
            fileSize: 4096,
        });
        expect(mocks.spawnCalls).toHaveLength(1);
        expect(mocks.spawnCalls[0]).toMatchObject({
            command: '/tools/ddjvu',
            args: [
                '-format=pbm',
                '-page=7',
                '-mode=mask',
                '/input.djvu',
                '/mask.pbm',
            ],
        });
    });

    it('falls back to the single process path when parallel range conversion fails', async () => {
        mocks.setSpawnMode('fail-ranges');

        const result = await convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-3', {pageCount: 24});

        expect(result.success).toBe(true);
        expect(mocks.loggerWarn).toHaveBeenCalledWith(expect.stringContaining('falling back to single process'));
        expect(mocks.unlink).toHaveBeenCalledWith('/output.pdf');
        expect(mocks.spawnCalls.filter(call => call.command === '/tools/ddjvu')).toHaveLength(5);
        expect(mocks.spawnCalls.at(-1)).toMatchObject({
            command: '/tools/ddjvu',
            args: [
                '-format=pdf',
                '-verbose',
                '/input.djvu',
                '/output.pdf',
            ],
        });
    });

    it('does not restart a canceled parallel conversion as a single-process conversion', async () => {
        mocks.setSpawnMode('hang-ranges');

        const convertPromise = convertDjvuToPdfFile('/input.djvu', '/output.pdf', 'job-4', {pageCount: 24});
        await vi.waitFor(() => {
            expect(mocks.spawnCalls.length).toBeGreaterThan(0);
        });

        const canceled = await cancelConversion('job-4');
        const result = await convertPromise;

        expect(canceled).toBe(true);
        expect(result).toEqual({
            success: false,
            outputPath: '/output.pdf',
            fileSize: 0,
            error: 'DjVu conversion canceled',
        });
        expect(mocks.spawnCalls.filter(call => (
            call.command === '/tools/ddjvu'
            && !call.args.some(arg => arg.startsWith('-page='))
        ))).toHaveLength(0);
    });

    it('cancels registered compact child processes by parent job prefix', async () => {
        mocks.setSpawnMode('hang-registered');

        const processPromise = runRegisteredDjvuProcess(
            'job-5-compact-combine',
            '/tools/evb-pdf-image-combine',
            [
                '--compact-manifest',
                '/tmp/manifest.tsv',
            ],
        );
        await vi.waitFor(() => {
            expect(mocks.spawnCalls.length).toBe(1);
        });

        const canceled = await cancelConversion('job-5');
        const result = await processPromise;

        expect(canceled).toBe(true);
        expect(mocks.terminateDetachedChildProcess).toHaveBeenCalledTimes(1);
        expect(result).toEqual({
            success: false,
            error: 'DjVu conversion canceled',
        });
    });
});
