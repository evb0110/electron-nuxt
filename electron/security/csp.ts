import { session } from 'electron';
import { config } from '@electron/config';

let isCspConfigured = false;

export function buildContentSecurityPolicy(isDev: boolean) {
    const connectSrc = isDev
        ? 'connect-src \'self\' ws: blob:'
        : 'connect-src \'self\' blob:';

    const scriptSrc = isDev
        ? 'script-src \'self\' \'unsafe-inline\' \'wasm-unsafe-eval\''
        : 'script-src \'self\'';
    const styleSrc = 'style-src \'self\' \'unsafe-inline\'';

    return [
        'default-src \'self\'',
        scriptSrc,
        'script-src-attr \'none\'',
        styleSrc,
        'img-src \'self\' data: blob:',
        'font-src \'self\' data:',
        connectSrc,
        'worker-src \'self\' blob:',
        'object-src \'none\'',
        'base-uri \'self\'',
        'frame-ancestors \'none\'',
        'form-action \'self\'',
    ].join('; ');
}

export function setupContentSecurityPolicy() {
    if (isCspConfigured) {
        return;
    }
    isCspConfigured = true;

    const csp = buildContentSecurityPolicy(config.isDev);

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [csp],
        }});
    });
}
