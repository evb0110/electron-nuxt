import { EventEmitter } from 'node:events';
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildFfmpegArtifactCommands,
    startDiagnosticFrameCapture,
} from '@scripts/diagnostics/diagnosticFrameCapture';

class FakeCdpClient extends EventEmitter {
    public readonly sentMethods: string[] = [];

    public async send(method: string) {
        this.sentMethods.push(method);
    }

    public async detach() {
        this.sentMethods.push('detach');
    }
}

describe('diagnostic frame capture', () => {
    it('builds ffmpeg commands for mp4 and contact-sheet artifacts', () => {
        const commands = buildFfmpegArtifactCommands({
            fps: 24,
            frameCount: 100,
            framesDir: '/repo/.devkit/blink-video/frames',
            outDir: '/repo/.devkit/blink-video',
        });

        expect(commands.mp4.outputPath).toBe('/repo/.devkit/blink-video/trace.mp4');
        expect(commands.mp4.args).toContain('/repo/.devkit/blink-video/frames/frame-*.jpg');
        expect(commands.mp4.args).toContain('libx264');
        expect(commands.contactSheet.outputPath).toBe('/repo/.devkit/blink-video/contact-sheet.jpg');
        expect(commands.contactSheet.args).toContain('select=\'not(mod(n\\,4))\',scale=320:-1,tile=5x5');
    });

    it('drains accepted CDP screencast frames during stop', async () => {
        const outDir = mkdtempSync(join(tmpdir(), 'evb-frame-capture-'));
        const client = new FakeCdpClient();
        const page = { target: () => ({ createCDPSession: async () => client }) };

        try {
            const capture = await startDiagnosticFrameCapture(page as never, {
                ffmpegCommand: process.execPath,
                outDir,
            });
            client.emit('Page.screencastFrame', {
                data: Buffer.from('first-frame').toString('base64'),
                sessionId: 1,
            });
            client.emit('Page.screencastFrame', {
                data: Buffer.from('second-frame').toString('base64'),
                sessionId: 2,
            });

            const result = await capture.stop();
            const frameFiles = readdirSync(result.framesDir).sort();

            expect(result.frameCount).toBe(2);
            expect(frameFiles).toHaveLength(2);
            const firstFrameFile = frameFiles[0];
            const secondFrameFile = frameFiles[1];
            if (!firstFrameFile || !secondFrameFile) {
                throw new Error('Expected two captured frame files');
            }
            expect(readFileSync(join(result.framesDir, firstFrameFile), 'utf8')).toBe('first-frame');
            expect(readFileSync(join(result.framesDir, secondFrameFile), 'utf8')).toBe('second-frame');
            expect(client.sentMethods.filter(method => method === 'Page.screencastFrameAck')).toHaveLength(2);
        } finally {
            rmSync(outDir, {
                force: true,
                recursive: true,
            });
        }
    });
});
