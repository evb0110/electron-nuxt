import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    buildPrintablePdfData: vi.fn(),
    listener: undefined as ((event: {data: unknown}) => void) | undefined,
    parentPort: {
        once: vi.fn(),
        postMessage: vi.fn(),
    },
    readFile: vi.fn(),
    stat: vi.fn(),
    writeFile: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    readFile: mocks.readFile,
    stat: mocks.stat,
    writeFile: mocks.writeFile,
}));

vi.mock('@pdf-core', () => ({buildPrintablePdfData: mocks.buildPrintablePdfData}));

const originalParentPortDescriptor = Object.getOwnPropertyDescriptor(process, 'parentPort');

async function waitForPostedResult() {
    await vi.waitFor(() => {
        expect(mocks.parentPort.postMessage).toHaveBeenCalledTimes(1);
    });
}

describe('PDF print layout utility process', () => {
    beforeAll(async () => {
        mocks.parentPort.once.mockImplementation((_eventName, listener) => {
            mocks.listener = listener as (event: {data: unknown}) => void;
            return mocks.parentPort;
        });
        Object.defineProperty(process, 'parentPort', {
            configurable: true,
            value: mocks.parentPort,
        });
        await import('@electron/features/documents/main/pdfPrintLayoutUtilityProcess');
    });

    beforeEach(() => {
        mocks.buildPrintablePdfData.mockReset();
        mocks.parentPort.postMessage.mockReset();
        mocks.readFile.mockReset();
        mocks.stat.mockReset();
        mocks.writeFile.mockReset();
    });

    afterAll(() => {
        if (originalParentPortDescriptor) {
            Object.defineProperty(process, 'parentPort', originalParentPortDescriptor);
        } else {
            Reflect.deleteProperty(process, 'parentPort');
        }
    });

    it('builds the requested printable PDF and reports its byte size', async () => {
        const sourceData = Uint8Array.from([
            1,
            2,
            3,
        ]);
        const printableData = Uint8Array.from([
            4,
            5,
            6,
            7,
        ]);
        mocks.stat.mockResolvedValue({
            isFile: () => true,
            size: sourceData.byteLength,
        });
        mocks.readFile.mockResolvedValue(sourceData);
        mocks.buildPrintablePdfData.mockResolvedValue(printableData);
        mocks.writeFile.mockResolvedValue(undefined);

        mocks.listener?.({data: {
            inputPath: '/documents/source.pdf',
            orientation: 'landscape',
            outputPath: '/documents/printable.pdf',
            pageNumbers: [
                1,
                4,
            ],
            viewMode: 'facing-first-single',
        }});
        await waitForPostedResult();

        expect(mocks.buildPrintablePdfData).toHaveBeenCalledWith(sourceData, {
            orientation: 'landscape',
            pageNumbers: [
                1,
                4,
            ],
            viewMode: 'facing-first-single',
        });
        expect(mocks.writeFile).toHaveBeenCalledWith(
            '/documents/printable.pdf',
            printableData,
            {flag: 'wx'},
        );
        expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
            bytes: printableData.byteLength,
            ok: true,
            type: 'result',
        });
    });

    it('reports malformed requests through the utility result protocol', async () => {
        mocks.listener?.({data: {inputPath: '/documents/source.pdf'}});
        await waitForPostedResult();

        expect(mocks.parentPort.postMessage).toHaveBeenCalledWith({
            error: 'Invalid PDF print layout utility request',
            ok: false,
            type: 'result',
        });
        expect(mocks.readFile).not.toHaveBeenCalled();
    });
});
