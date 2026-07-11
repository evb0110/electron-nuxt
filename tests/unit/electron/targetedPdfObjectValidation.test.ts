import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {validateTargetedPdfObjects} from '@electron/features/documents/main/validateTargetedPdfObjects';

describe('targeted PDF object validation', () => {
    it('checks only changed xref objects with bounded sequential output buffers', async () => {
        let active = 0;
        let peakActive = 0;
        const run = vi.fn(async () => {
            active += 1;
            peakActive = Math.max(peakActive, active);
            await Promise.resolve();
            active -= 1;
            return {
                stdout: '<< /Type /Annot >>',
                stderr: '',
            };
        });
        const refs = Array.from({length: 128}, (_value, index) => `${index + 1} 0 R`);

        await validateTargetedPdfObjects('/tmp/staged.pdf', '/usr/bin/qpdf', refs, run as never);

        expect(run).toHaveBeenCalledTimes(refs.length);
        expect(peakActive).toBe(1);
        expect(run.mock.calls[0]).toEqual([
            '/usr/bin/qpdf',
            [
                '--show-object=1,0',
                '/tmp/staged.pdf',
            ],
            expect.objectContaining({maxBuffer: 1024 * 1024}),
        ]);
    });

    it('rejects a missing changed object', async () => {
        const run = vi.fn(async () => ({
            stdout: 'null\n',
            stderr: '',
        }));

        await expect(validateTargetedPdfObjects(
            '/tmp/staged.pdf',
            '/usr/bin/qpdf',
            ['12 0 R'],
            run as never,
        )).rejects.toThrow('12 0 R is missing');
    });
});
