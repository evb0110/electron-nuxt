import {
    describe,
    expect,
    it,
} from 'vitest';
import { getAssistantContentReportUrl } from '@app/modules/agent-panel/utils/getAssistantContentReportUrl';

describe('assistantContentReport', () => {
    it('opens a prefilled public report without copying assistant content into the URL', () => {
        const url = new URL(getAssistantContentReportUrl());

        expect(url.origin + url.pathname).toBe('https://github.com/evb0110/evb-viewer/issues/new');
        expect(url.searchParams.get('title')).toBe('Report an inappropriate AI-generated response');
        expect(url.searchParams.get('body')).toContain('Do not include private documents');
        expect(url.searchParams.get('body')).toContain('Assistant provider and model');
    });
});
