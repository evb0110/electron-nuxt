import {
    describe,
    expect,
    it,
} from 'vitest';
import { formatAssistantMessage } from '@app/modules/agent-panel/utils/assistantMessageFormatting';

describe('assistantMessageFormatting', () => {
    it('preserves plain text while splitting inline code spans', () => {
        expect(formatAssistantMessage('Use `smth` here.')).toEqual([{
            kind: 'text',
            segments: [
                {
                    kind: 'text',
                    text: 'Use ',
                },
                {
                    kind: 'code',
                    text: 'smth',
                },
                {
                    kind: 'text',
                    text: ' here.',
                },
            ],
        }]);
    });

    it('keeps fenced code blocks separate from surrounding text', () => {
        expect(formatAssistantMessage('Before\n```ts\nconst value = 1;\n```\nAfter')).toEqual([
            {
                kind: 'text',
                segments: [{
                    kind: 'text',
                    text: 'Before',
                }],
            },
            {
                kind: 'code',
                language: 'ts',
                code: 'const value = 1;',
            },
            {
                kind: 'text',
                segments: [{
                    kind: 'text',
                    text: 'After',
                }],
            },
        ]);
    });

    it('renders an unfinished fenced block as code for streaming messages', () => {
        expect(formatAssistantMessage('```json\n{"ok": true}')).toEqual([{
            kind: 'code',
            language: 'json',
            code: '{"ok": true}',
        }]);
    });
});
