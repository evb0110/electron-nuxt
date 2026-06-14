import {
    describe,
    expect,
    it,
} from 'vitest';
import { formatAssistantMessage } from '@app/modules/agent-panel/utils/formatAssistantMessage';

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

    it('splits strong emphasis markers into safe inline segments', () => {
        expect(formatAssistantMessage(
            'This PDF is **Die syrische Chronik des Josua Stylites** by **Andreas Luther**.',
        )).toEqual([{
            kind: 'text',
            segments: [
                {
                    kind: 'text',
                    text: 'This PDF is ',
                },
                {
                    kind: 'strong',
                    text: 'Die syrische Chronik des Josua Stylites',
                },
                {
                    kind: 'text',
                    text: ' by ',
                },
                {
                    kind: 'strong',
                    text: 'Andreas Luther',
                },
                {
                    kind: 'text',
                    text: '.',
                },
            ],
        }]);
    });

    it('recognizes common markdown blocks produced by agents', () => {
        expect(formatAssistantMessage([
            '# Summary',
            '- **Ready** item',
            '- [Docs](https://example.com/docs)',
            '> quoted *note*',
            '---',
        ].join('\n'))).toEqual([
            {
                kind: 'heading',
                level: 1,
                segments: [{
                    kind: 'text',
                    text: 'Summary',
                }],
            },
            {
                kind: 'list',
                ordered: false,
                items: [
                    [
                        {
                            kind: 'strong',
                            text: 'Ready',
                        },
                        {
                            kind: 'text',
                            text: ' item',
                        },
                    ],
                    [{
                        kind: 'link',
                        text: 'Docs',
                        href: 'https://example.com/docs',
                    }],
                ],
            },
            {
                kind: 'blockquote',
                segments: [
                    {
                        kind: 'text',
                        text: 'quoted ',
                    },
                    {
                        kind: 'emphasis',
                        text: 'note',
                    },
                ],
            },
            { kind: 'rule' },
        ]);
    });

    it('marks ordered lists separately from unordered lists', () => {
        expect(formatAssistantMessage('1. First\n2. Second')).toEqual([{
            kind: 'list',
            ordered: true,
            items: [
                [{
                    kind: 'text',
                    text: 'First',
                }],
                [{
                    kind: 'text',
                    text: 'Second',
                }],
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
