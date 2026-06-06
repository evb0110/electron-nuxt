import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    detectSourceDpi,
    detectSourceDpiDetails,
} from '@electron/ocr/worker/dpiDetection';

const mocks = vi.hoisted(() => ({runOcrCommand: vi.fn()}));

vi.mock('@electron/ocr/worker/runOcrCommand', () => ({runOcrCommand: mocks.runOcrCommand}));

describe('ocr dpi detection', () => {
    it('keeps per-page source dpi while preserving document fallback dpi', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
                '--------------------------------------------------------------------------------------------',
                '   4     3 image    2630  2159  rgb     3   8  image  no      3721  0    72    72 4986K  30%',
                '   5     4 image    1617  2800  sep     1   8  image  no      4330  0   239   239 90.9K 2.1%',
                '   5     5 image     100   100  sep     1   8  image  no      4331  0   300   300  1.0K 1.0%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        const result = await detectSourceDpiDetails('/tmp/input.pdf', '/bin/pdfimages', vi.fn());

        expect(result.documentDpi).toBe(300);
        expect(result.pageDpiByNumber.get(4)).toBe(72);
        expect(result.pageDpiByNumber.get(5)).toBe(300);
    });

    it('returns the document dpi for the legacy detector', async () => {
        mocks.runOcrCommand.mockResolvedValueOnce({
            stdout: [
                'page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio',
                '   1     0 image    1262  1036  gray    1   8  jpeg   no      3421  0   200   200 62.8K 4.9%',
            ].join('\n'),
            stderr: '',
            exitCode: 0,
        });

        await expect(detectSourceDpi('/tmp/input.pdf', '/bin/pdfimages', vi.fn())).resolves.toBe(200);
    });
});
