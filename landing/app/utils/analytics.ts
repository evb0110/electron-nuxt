interface IAnalyticsPageViewPayload {
    path: string;
    referrer: string | null;
}

interface IAnalyticsDownloadPayload {
    platform: string;
    arch: string;
    version: string;
    fileName: string;
}

type TAnalyticsPayload = IAnalyticsPageViewPayload | IAnalyticsDownloadPayload;

function postAnalytics(path: '/api/analytics/pageView' | '/api/analytics/download', payload: TAnalyticsPayload) {
    if (typeof fetch !== 'function') {
        return;
    }

    fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    }).catch(() => {});
}

export function trackPageView(payload: IAnalyticsPageViewPayload) {
    postAnalytics('/api/analytics/pageView', payload);
}

export function trackDownload(payload: IAnalyticsDownloadPayload) {
    postAnalytics('/api/analytics/download', payload);
}
