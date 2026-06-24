import { session } from 'electron';
import { config } from '@electron/config';

let isCspConfigured = false;

export function buildContentSecurityPolicy(isDev: boolean) {
    const connectSrc = isDev
        ? 'connect-src \'self\' ws: blob:'
        : 'connect-src \'self\' blob:';

    // Nuxt SPA renderer injects inline payload/config scripts in both dev and production.
    // Blocking inline scripts breaks bootstrap at startup (`window.__NUXT__` never initializes).
    // 'wasm-unsafe-eval' is required in production too: pdf.js's renderer WebWorker compiles
    // bundled WASM (jbig2, openjpeg, qcms, quickjs-eval) on demand for PDFs containing
    // JBIG2/JPEG2000-encoded images, ICC color profiles, or JS actions. Without this directive
    // those PDFs silently fail to render those streams.
    const scriptSrc = 'script-src \'self\' \'unsafe-inline\' \'wasm-unsafe-eval\'';
    // Vue/PDF.js render geometry through inline style attributes and Electron preload injects a small style tag.
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
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
        callback(false);
    });

    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': [csp],
        }});
    });
}
