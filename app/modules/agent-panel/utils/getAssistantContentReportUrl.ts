const ASSISTANT_CONTENT_REPORT_BASE_URL = 'https://github.com/evb0110/evb-viewer/issues/new';

const ASSISTANT_CONTENT_REPORT_TITLE = 'Report an inappropriate AI-generated response';

const ASSISTANT_CONTENT_REPORT_BODY = [
    '## What happened?',
    '',
    'Describe the problematic AI-generated response and why it should be reviewed.',
    '',
    '> Do not include private documents, personal information, credentials, or other sensitive data.',
    '',
    '## Context',
    '',
    '- EVB Viewer version:',
    '- Assistant provider and model:',
    '- Steps to reproduce:',
].join('\n');

export function getAssistantContentReportUrl() {
    const url = new URL(ASSISTANT_CONTENT_REPORT_BASE_URL);
    url.searchParams.set('title', ASSISTANT_CONTENT_REPORT_TITLE);
    url.searchParams.set('body', ASSISTANT_CONTENT_REPORT_BODY);
    return url.toString();
}
