import React, {
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import {
    Alert,
    AppState,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    Text,
    View,
} from 'react-native';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import * as DocumentPicker from 'expo-document-picker';
import { File as ExpoFile } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import WebView from 'react-native-webview';
import type { WebViewMessageEvent } from 'react-native-webview';
import {
    READER_COMMAND_DESCRIPTORS,
    type TReaderCommandId,
} from '@evb/contracts/reader-commands';
import type { IRecentFile } from '@evb/contracts/shared';
import type {
    THostToViewerMessage,
    TViewerToHostMessage,
} from '@evb/contracts/rn-webview-protocol';
import {
    encodeBridgeMessage,
    parseViewerMessage,
} from './bridge';

const DEFAULT_VIEWER_PATH = '/mobile-reader-proof';
const VIEWER_READY_TIMEOUT_MS = 12_000;
const VIEWER_READY_PING_MS = 500;
const DOCUMENT_LOAD_TIMEOUT_MS = 45_000;
const DOCUMENT_SERVER_PROBE_TIMEOUT_MS = 10_000;
const OPEN_INTENT_RETRY_MS = 900;
const OPEN_INTENT_RETRY_LIMIT = 50;
const TRANSFER_REPLACED_MESSAGE = 'Document open was replaced by another selection.';
const MAX_NATIVE_RECENT_FILES = 12;
const SERVED_DOCUMENTS_DIR_NAME = 'evb-viewer-documents';
const DEVELOPMENT_BUILD_REQUIRED_MESSAGE = [
    'Opening PDFs requires an Expo development build that includes EVB native modules.',
    'Expo Go and development builds installed before the native document server was added do not include ReactNativeFs.',
    'Rebuild and reinstall the mobile app with `pnpm --dir apps/mobile-spike android` or `pnpm --dir apps/mobile-spike ios`.',
].join(' ');
const WEBVIEW_BOOTSTRAP_SCRIPT = `
(function () {
  if (window.__evbMobileBridgeBootstrapInstalled) {
    return true;
  }
  window.__evbMobileBridgeBootstrapInstalled = true;
  function post(message) {
    try {
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(message));
    } catch (error) {}
  }
  function serialize(args) {
    return args.map(function (arg) {
      if (arg instanceof Error) {
        return arg.stack || arg.message;
      }
      if (typeof arg === 'string') {
        return arg;
      }
      try {
        return JSON.stringify(arg);
      } catch (error) {
        return String(arg);
      }
    }).join(' ');
  }
  ['debug', 'info', 'warn', 'error'].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      post({ type: 'viewer:console', level: level, message: serialize(args) });
      if (typeof original === 'function') {
        original.apply(console, args);
      }
    };
  });
  window.addEventListener('error', function (event) {
    post({ type: 'viewer:console', level: 'error', message: event.message || 'Unhandled WebView error' });
  });
  window.addEventListener('unhandledrejection', function (event) {
    post({ type: 'viewer:console', level: 'error', message: serialize([event.reason || 'Unhandled WebView rejection']) });
  });
  post({ type: 'viewer:console', level: 'info', message: 'bridge bootstrap installed' });
  return true;
})();
`;

const MENU_COMMANDS: TReaderCommandId[] = [
    'fit-width',
    'fit-height',
    'continuous-scroll',
    'drag-mode',
    'text-select',
    'settings',
];

interface IOpenedDocument {
    documentId: string;
    name: string;
    ref: string;
    size: number;
}

interface INativeDocumentSource {
    name: string;
    servedFileName: string;
    servedPath: string;
    sourceUri: string;
    size: number;
    mimeType: string;
}

interface IImportedNativeDocument extends INativeDocumentSource {
    documentId: string;
    readerUrl: string;
    ref: string;
}

type TPendingOpenedDocument = IOpenedDocument;

interface IOpenIntent {
    documentId: string;
    message: Extract<THostToViewerMessage, { type: 'document:open' | 'document:open-url' | 'document:open-ranged' }>;
    deliveredGenerations: Set<number>;
    acknowledgedGeneration: number | null;
    attemptCount: number;
}

interface IDeferred<T> {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface IViewerUrlResolution {
    source: string;
    url: string;
}

type TOpenTrigger = 'native-button' | 'webview-request';
type TPickerBackend = 'expo-file-system' | 'expo-document-picker';

type TStaticServerInstance = InstanceType<typeof import('@dr.pogodin/react-native-static-server').default>;
type TReactNativeFsModule = typeof import('@dr.pogodin/react-native-fs');

interface IPickedDocumentAsset {
    backend: TPickerBackend;
    file?: ExpoFile;
    mimeType: string;
    name: string;
    size: number;
    uri: string;
}

function hostFromUri(uri: string | null | undefined) {
    if (!uri) {
        return null;
    }

    const normalizedUri = uri.includes('://') ? uri : `http://${uri}`;
    try {
        return new URL(normalizedUri).hostname;
    } catch {
        const match = /^([^:/]+)/.exec(uri);
        return match?.[1] ?? null;
    }
}

function makeViewerUrl(host: string) {
    return `http://${host}:3235${DEFAULT_VIEWER_PATH}`;
}

function resolveViewerUrl(): IViewerUrlResolution {
    if (process.env.EXPO_PUBLIC_VIEWER_URL) {
        return {
            source: 'EXPO_PUBLIC_VIEWER_URL',
            url: process.env.EXPO_PUBLIC_VIEWER_URL,
        };
    }

    const expoConfigHost = hostFromUri(Constants.expoConfig?.hostUri);
    if (expoConfigHost && expoConfigHost !== 'localhost') {
        return {
            source: 'Constants.expoConfig.hostUri',
            url: makeViewerUrl(expoConfigHost),
        };
    }

    const expoGoHost = hostFromUri(Constants.expoGoConfig?.debuggerHost);
    if (expoGoHost && expoGoHost !== 'localhost') {
        return {
            source: 'Constants.expoGoConfig.debuggerHost',
            url: makeViewerUrl(expoGoHost),
        };
    }

    if (Platform.OS === 'android') {
        return {
            source: 'android-emulator-fallback',
            url: makeViewerUrl('10.0.2.2'),
        };
    }

    return {
        source: 'ios-simulator-fallback',
        url: makeViewerUrl('127.0.0.1'),
    };
}

function isExpoGoRuntime() {
    return Constants.executionEnvironment === ExecutionEnvironment.StoreClient
        || Constants.appOwnership === 'expo';
}

function isPickerCancelError(error: unknown) {
    if (!(error instanceof Error)) {
        return false;
    }

    return /cancel/i.test(error.message);
}

async function pickWithFileSystem(): Promise<IPickedDocumentAsset | null> {
    const picked = await ExpoFile.pickFileAsync(undefined, 'application/pdf');
    const pickedFile = Array.isArray(picked) ? picked[0] : picked;
    if (!pickedFile) {
        return null;
    }

    const file = new ExpoFile(pickedFile.uri);
    return {
        backend: 'expo-file-system',
        file,
        mimeType: file.type || 'application/pdf',
        name: file.name || 'document.pdf',
        size: file.size,
        uri: file.uri,
    };
}

async function pickWithDocumentPicker(): Promise<IPickedDocumentAsset | null> {
    const result = await DocumentPicker.getDocumentAsync({
        base64: false,
        copyToCacheDirectory: true,
        multiple: false,
        type: [
            'application/pdf',
            'application/octet-stream',
            '*/*',
        ],
    });

    if (result.canceled) {
        return null;
    }

    const asset = result.assets[0];
    if (!asset) {
        return null;
    }

    return {
        backend: 'expo-document-picker',
        mimeType: asset.mimeType ?? 'application/pdf',
        name: asset.name,
        size: asset.size ?? 0,
        uri: asset.uri,
    };
}

async function pickNativePdf(): Promise<IPickedDocumentAsset | null> {
    if (Platform.OS === 'android') {
        console.info('[mobile-spike] opening picker via expo-document-picker');
        return pickWithDocumentPicker();
    }

    try {
        console.info('[mobile-spike] opening picker via expo-file-system');
        return await pickWithFileSystem();
    } catch (error) {
        if (isPickerCancelError(error)) {
            return null;
        }
        console.warn(`[mobile-spike] expo-file-system picker failed, falling back to expo-document-picker: ${
            error instanceof Error ? error.message : String(error)
        }`);
    }

    console.info('[mobile-spike] opening picker via expo-document-picker');
    return pickWithDocumentPicker();
}

function createDocumentId() {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1_000_000);
    return `${timestamp}-${random}`;
}

function sanitizeServedFileName(name: string) {
    const trimmed = name.trim() || 'document.pdf';
    const safe = trimmed
        .replace(/[^\w .()-]+/gu, '_')
        .replace(/\s+/gu, ' ')
        .slice(0, 120)
        .trim();
    return safe || 'document.pdf';
}

function buildServedFileName(documentId: string, name: string) {
    return `${documentId}-${sanitizeServedFileName(name)}`;
}

function buildServedDocumentUrl(origin: string, fileName: string) {
    return `${origin}/${encodeURIComponent(fileName)}`;
}

async function probeServedDocumentUrl(url: string, expectedSize: number) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DOCUMENT_SERVER_PROBE_TIMEOUT_MS);
    try {
        const response = await fetch(url, {
            headers: { Range: 'bytes=0-1023' },
            signal: controller.signal,
        });
        if (!response.ok && response.status !== 206) {
            throw new Error(`Unexpected status ${response.status}`);
        }
        const bytes = await response.arrayBuffer();
        if (!bytes.byteLength) {
            throw new Error('Local document server returned an empty probe response.');
        }
        const contentRange = response.headers.get('content-range');
        const contentLength = response.headers.get('content-length');
        console.info(`[mobile-spike] local document probe ok: status=${response.status}, bytes=${bytes.byteLength}, content-length=${contentLength ?? 'none'}, content-range=${contentRange ?? 'none'}, expected-size=${expectedSize}`);
    } finally {
        clearTimeout(timeout);
    }
}

export default function App() {
    const webViewRef = useRef<WebView>(null);
    const pendingMessages = useRef<THostToViewerMessage[]>([]);
    const documentLoadResolvers = useRef(new Map<string, IDeferred<void>>());
    const nativeDocuments = useRef(new Map<string, INativeDocumentSource>());
    const nativeRecentFiles = useRef<IRecentFile[]>([]);
    const nativeFsModule = useRef<TReactNativeFsModule | null>(null);
    const documentServer = useRef<TStaticServerInstance | null>(null);
    const documentServerOrigin = useRef<string | null>(null);
    const servedDocumentsDir = useRef<string | null>(null);
    const openDocumentRef = useRef<((trigger: TOpenTrigger) => Promise<void>) | null>(null);
    const openRecentDocumentRef = useRef<((ref: string) => Promise<void>) | null>(null);
    const pendingOpenIntent = useRef<IOpenIntent | null>(null);
    const pendingOpenedDocument = useRef<TPendingOpenedDocument | null>(null);
    const viewerGeneration = useRef(0);
    const openIntentRetryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewerReadyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewerPingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
    const viewerResolution = useMemo(() => resolveViewerUrl(), []);
    const viewerUrl = viewerResolution.url;
    const [isViewerReady, setIsViewerReady] = useState(false);
    const [isMenuOpen, setIsMenuOpen] = useState(false);
    const [openedDocument, setOpenedDocument] = useState<IOpenedDocument | null>(null);
    const [pageLabel, setPageLabel] = useState('No document');
    const [lastEvent, setLastEvent] = useState('Waiting for viewer');
    const [loadError, setLoadError] = useState<string | null>(null);
    const [isViewerLoading, setIsViewerLoading] = useState(false);
    const [activeTransfer, setActiveTransfer] = useState<string | null>(null);

    const source = useMemo(() => ({ uri: viewerUrl }), [viewerUrl]);

    const clearViewerReadyTimer = useCallback(() => {
        if (viewerReadyTimer.current) {
            clearTimeout(viewerReadyTimer.current);
            viewerReadyTimer.current = null;
        }
    }, []);

    const clearViewerPingTimer = useCallback(() => {
        if (viewerPingTimer.current) {
            clearInterval(viewerPingTimer.current);
            viewerPingTimer.current = null;
        }
    }, []);

    const clearOpenIntentRetryTimer = useCallback(() => {
        if (openIntentRetryTimer.current) {
            clearTimeout(openIntentRetryTimer.current);
            openIntentRetryTimer.current = null;
        }
    }, []);

    const pingViewer = useCallback(() => {
        webViewRef.current?.postMessage(encodeBridgeMessage({
            type: 'host:ping',
            requestId: `${Date.now()}`,
        }));
    }, []);

    const beginViewerLoad = useCallback((event: string) => {
        viewerGeneration.current += 1;
        pendingMessages.current = [];
        clearViewerReadyTimer();
        clearViewerPingTimer();
        setIsViewerReady(false);
        setIsViewerLoading(true);
        setLoadError(null);
        setLastEvent(event);
        console.info(`[mobile-spike] ${event}: ${viewerUrl} (${viewerResolution.source})`);
        viewerPingTimer.current = setInterval(pingViewer, VIEWER_READY_PING_MS);
        setTimeout(pingViewer, 250);
        viewerReadyTimer.current = setTimeout(() => {
            clearViewerPingTimer();
            setIsViewerLoading(false);
            setLoadError(`Timed out waiting for viewer:ready from ${viewerUrl}`);
            setLastEvent('Viewer ready timed out');
            console.warn(`[mobile-spike] viewer:ready timed out: ${viewerUrl}`);
        }, VIEWER_READY_TIMEOUT_MS);
    }, [
        clearViewerPingTimer,
        clearViewerReadyTimer,
        pingViewer,
        viewerResolution.source,
        viewerUrl,
    ]);

    const postToViewer = useCallback((message: THostToViewerMessage) => {
        if (!isViewerReady) {
            pendingMessages.current.push(message);
            return;
        }

        webViewRef.current?.postMessage(encodeBridgeMessage(message));
    }, [isViewerReady]);

    const flushPendingMessages = useCallback(() => {
        const messages = pendingMessages.current.splice(0);

        for (const message of messages) {
            webViewRef.current?.postMessage(encodeBridgeMessage(message));
        }
    }, []);

    const sendToViewerNow = useCallback((message: THostToViewerMessage) => {
        webViewRef.current?.postMessage(encodeBridgeMessage(message));
    }, []);

    const loadNativeDocumentServerModules = useCallback(async () => {
        if (nativeFsModule.current) {
            return nativeFsModule.current;
        }

        if (isExpoGoRuntime()) {
            throw new Error(DEVELOPMENT_BUILD_REQUIRED_MESSAGE);
        }

        try {
            const fsModule = await import('@dr.pogodin/react-native-fs');
            nativeFsModule.current = fsModule;
            return fsModule;
        } catch (error) {
            throw new Error(
                DEVELOPMENT_BUILD_REQUIRED_MESSAGE,
                { cause: error },
            );
        }
    }, []);

    const ensureDocumentServer = useCallback(async () => {
        const fsModule = await loadNativeDocumentServerModules();
        const documentDir = `${fsModule.DocumentDirectoryPath}/${SERVED_DOCUMENTS_DIR_NAME}`;
        if (servedDocumentsDir.current !== documentDir) {
            await fsModule.mkdir(documentDir);
            servedDocumentsDir.current = documentDir;
        } else if (!(await fsModule.exists(documentDir))) {
            await fsModule.mkdir(documentDir);
        }

        if (!documentServer.current) {
            const { default: StaticServer } = await import('@dr.pogodin/react-native-static-server');
            const server = new StaticServer({
                errorLog: true,
                fileDir: documentDir,
                hostname: '127.0.0.1',
                port: 0,
                stopInBackground: false,
            });
            server.addStateListener((state, details, error) => {
                const suffix = details ? `: ${details}` : '';
                if (error) {
                    console.warn(`[mobile-spike] document server ${state}${suffix}: ${error.message}`);
                } else {
                    console.info(`[mobile-spike] document server ${state}${suffix}`);
                }
            });
            documentServer.current = server;
        }

        const origin = await documentServer.current.start('Opening local document server');
        documentServerOrigin.current = origin;
        return {
            documentDir,
            fsModule,
            origin,
        };
    }, [loadNativeDocumentServerModules]);

    const importPickedDocument = useCallback(async (asset: IPickedDocumentAsset): Promise<IImportedNativeDocument> => {
        const {
            documentDir,
            fsModule,
            origin,
        } = await ensureDocumentServer();
        const documentId = createDocumentId();
        const documentRef = `rn://document/${encodeURIComponent(documentId)}`;
        const servedFileName = buildServedFileName(documentId, asset.name);
        const servedPath = `${documentDir}/${servedFileName}`;
        await fsModule.copyFile(asset.uri, servedPath);
        const stat = await fsModule.stat(servedPath);
        const size = Number(stat.size) || asset.size;
        if (!size || size <= 0) {
            throw new Error('The selected file could not be imported or its size is unknown.');
        }

        return {
            documentId,
            ref: documentRef,
            readerUrl: buildServedDocumentUrl(origin, servedFileName),
            name: asset.name,
            servedFileName,
            servedPath,
            sourceUri: asset.uri,
            size,
            mimeType: asset.mimeType,
        };
    }, [ensureDocumentServer]);

    const getReaderUrlForDocument = useCallback(async (document: INativeDocumentSource) => {
        const { origin } = await ensureDocumentServer();
        return buildServedDocumentUrl(origin, document.servedFileName);
    }, [ensureDocumentServer]);

    const publishRecentFiles = useCallback(() => {
        sendToViewerNow({
            type: 'recent-files:changed',
            recentFiles: nativeRecentFiles.current,
        });
    }, [sendToViewerNow]);

    const touchRecentFile = useCallback((document: TPendingOpenedDocument) => {
        nativeRecentFiles.current = [
            {
                originalPath: document.ref,
                fileName: document.name,
                timestamp: Date.now(),
                fileSize: document.size,
            },
            ...nativeRecentFiles.current.filter(file => file.originalPath !== document.ref),
        ].slice(0, MAX_NATIVE_RECENT_FILES);
        publishRecentFiles();
    }, [publishRecentFiles]);

    const deliverPendingOpenIntent = useCallback((force = false) => {
        const intent = pendingOpenIntent.current;
        if (!intent) {
            return;
        }

        const generation = viewerGeneration.current;
        if (intent.acknowledgedGeneration === generation) {
            return;
        }
        if (!force && intent.deliveredGenerations.has(generation)) {
            return;
        }
        if (intent.attemptCount >= OPEN_INTENT_RETRY_LIMIT) {
            return;
        }

        intent.deliveredGenerations.add(generation);
        intent.attemptCount += 1;
        console.info(`[mobile-spike] delivering ${intent.message.type} for ${intent.documentId} on viewer generation ${generation}, attempt ${intent.attemptCount}`);
        sendToViewerNow(intent.message);
        clearOpenIntentRetryTimer();
        openIntentRetryTimer.current = setTimeout(() => {
            const current = pendingOpenIntent.current;
            if (!current || current.documentId !== intent.documentId) {
                return;
            }

            deliverPendingOpenIntent(true);
        }, OPEN_INTENT_RETRY_MS);
    }, [
        clearOpenIntentRetryTimer,
        sendToViewerNow,
    ]);

    const markViewerReady = useCallback(() => {
        clearViewerPingTimer();
        clearViewerReadyTimer();
        setIsViewerLoading(false);
        setLoadError(null);
        setIsViewerReady(true);
        flushPendingMessages();
        publishRecentFiles();
        deliverPendingOpenIntent();
    }, [
        clearViewerPingTimer,
        clearViewerReadyTimer,
        deliverPendingOpenIntent,
        flushPendingMessages,
        publishRecentFiles,
    ]);

    const waitForDocumentLoaded = useCallback((documentId: string) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
            documentLoadResolvers.current.delete(documentId);
            reject(new Error('Timed out waiting for the reader to open the selected PDF.'));
        }, DOCUMENT_LOAD_TIMEOUT_MS);
        documentLoadResolvers.current.set(documentId, {
            resolve,
            reject,
            timer,
        });
    }), []);

    const resolveDocumentLoaded = useCallback((documentId: string) => {
        const deferred = documentLoadResolvers.current.get(documentId);
        if (!deferred) {
            return;
        }
        clearTimeout(deferred.timer);
        documentLoadResolvers.current.delete(documentId);
        deferred.resolve();
    }, []);

    const respondWithDocumentRange = useCallback(async (
        requestId: string,
        ref: string,
        offset: number,
        length: number,
    ) => {
        const document = nativeDocuments.current.get(ref);
        if (!document) {
            console.warn(`[mobile-spike] range requested for unknown document: ${ref}`);
            return;
        }

        const safeOffset = Math.max(0, Math.floor(offset));
        const safeLength = Math.max(0, Math.floor(length));
        const boundedLength = Math.min(safeLength, Math.max(0, document.size - safeOffset));
        try {
            const base64 = boundedLength > 0
                ? await LegacyFileSystem.readAsStringAsync(document.sourceUri, {
                    encoding: LegacyFileSystem.EncodingType.Base64,
                    position: safeOffset,
                    length: boundedLength,
                })
                : '';
            sendToViewerNow({
                type: 'document:range',
                requestId,
                offset: safeOffset,
                base64,
                eof: safeOffset + boundedLength >= document.size,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[mobile-spike] range read failed: ${message}`);
            sendToViewerNow({
                type: 'document:range',
                requestId,
                offset: safeOffset,
                base64: '',
                eof: true,
                error: message,
            });
        }
    }, [sendToViewerNow]);

    const rejectPendingTransfers = useCallback((message: string) => {
        const error = new Error(message);
        for (const deferred of documentLoadResolvers.current.values()) {
            clearTimeout(deferred.timer);
            deferred.reject(error);
        }
        documentLoadResolvers.current.clear();
        pendingOpenIntent.current = null;
        pendingOpenedDocument.current = null;
        clearOpenIntentRetryTimer();
        setActiveTransfer(null);
    }, [clearOpenIntentRetryTimer]);

    useEffect(() => {
        beginViewerLoad('Loading viewer');
        return () => {
            clearViewerPingTimer();
            clearViewerReadyTimer();
            clearOpenIntentRetryTimer();
            rejectPendingTransfers('Mobile shell unmounted.');
            void documentServer.current?.stop('Mobile shell unmounted');
        };
    }, [
        beginViewerLoad,
        clearOpenIntentRetryTimer,
        clearViewerPingTimer,
        clearViewerReadyTimer,
        rejectPendingTransfers,
    ]);

    useEffect(() => {
        const subscription = AppState.addEventListener('change', state => {
            if (state === 'active' && isViewerReady && !loadError) {
                setLastEvent('Verifying reader');
                if (nativeDocuments.current.size > 0) {
                    void ensureDocumentServer().catch(error => {
                        console.warn(`[mobile-spike] failed to restart document server: ${
                            error instanceof Error ? error.message : String(error)
                        }`);
                    });
                }
                sendToViewerNow({
                    type: 'host:ping',
                    requestId: `${Date.now()}`,
                });
                deliverPendingOpenIntent(true);
            }
        });
        return () => subscription.remove();
    }, [
        deliverPendingOpenIntent,
        ensureDocumentServer,
        isViewerReady,
        loadError,
        sendToViewerNow,
    ]);

    const handleViewerMessage = useCallback((event: WebViewMessageEvent) => {
        const message = parseViewerMessage(event.nativeEvent.data);
        if (!message) {
            return;
        }

        setLastEvent(message.type);
        if (message.type === 'viewer:console') {
            const text = `[mobile-spike:webview] ${message.message}`;
            if (message.level === 'error') {
                console.error(text);
            } else if (message.level === 'warn') {
                console.warn(text);
            } else {
                console.info(text);
            }
            return;
        }
        if (message.type === 'viewer:ready') {
            console.info('[mobile-spike] viewer:ready');
            markViewerReady();
            return;
        }
        if (message.type === 'document:loaded') {
            setPageLabel(`1 / ${message.pageCount}`);
            if (message.documentId) {
                const pendingDocument = pendingOpenedDocument.current;
                if (pendingDocument?.documentId === message.documentId) {
                    setOpenedDocument(pendingDocument);
                    touchRecentFile(pendingDocument);
                    pendingOpenedDocument.current = null;
                }
                const intent = pendingOpenIntent.current;
                if (intent?.documentId === message.documentId) {
                    pendingOpenIntent.current = null;
                    clearOpenIntentRetryTimer();
                }
                resolveDocumentLoaded(message.documentId);
                setActiveTransfer(null);
            }
            return;
        }
        if (message.type === 'document:request-open') {
            console.info('[mobile-spike] open requested from WebView');
            void openDocumentRef.current?.('webview-request');
            return;
        }
        if (message.type === 'recent-files:request') {
            publishRecentFiles();
            return;
        }
        if (message.type === 'recent-file:open') {
            void openRecentDocumentRef.current?.(message.ref);
            return;
        }
        if (message.type === 'recent-file:remove') {
            nativeRecentFiles.current = nativeRecentFiles.current.filter(file => file.originalPath !== message.ref);
            publishRecentFiles();
            return;
        }
        if (message.type === 'recent-files:clear') {
            nativeRecentFiles.current = [];
            publishRecentFiles();
            return;
        }
        if (message.type === 'document:open-started') {
            console.info(`[mobile-spike] reader opening ${message.documentId}`);
            const intent = pendingOpenIntent.current;
            if (intent?.documentId === message.documentId) {
                intent.acknowledgedGeneration = viewerGeneration.current;
                clearOpenIntentRetryTimer();
            }
            return;
        }
        if (message.type === 'document:request-range') {
            void respondWithDocumentRange(
                message.requestId,
                message.ref,
                message.offset,
                message.length,
            );
            return;
        }
        if (message.type === 'reader:page-changed') {
            setPageLabel(`${message.page} / ${message.pageCount}`);
            return;
        }
        if (message.type === 'viewer:error') {
            rejectPendingTransfers(message.message);
            Alert.alert('Viewer error', message.message);
        }
    }, [
        clearViewerPingTimer,
        clearViewerReadyTimer,
        clearOpenIntentRetryTimer,
        deliverPendingOpenIntent,
        flushPendingMessages,
        markViewerReady,
        publishRecentFiles,
        rejectPendingTransfers,
        respondWithDocumentRange,
        resolveDocumentLoaded,
        touchRecentFile,
    ]);

    const openDocument = useCallback(async (trigger: TOpenTrigger) => {
        console.info(`[mobile-spike] open requested from ${trigger}`);
        if (activeTransfer) {
            if (trigger === 'webview-request') {
                console.info(`[mobile-spike] ignoring duplicate WebView open request during active transfer: ${activeTransfer}`);
                setLastEvent(`Still opening ${activeTransfer}`);
                return;
            }
            console.info(`[mobile-spike] replacing active transfer: ${activeTransfer}`);
            rejectPendingTransfers(TRANSFER_REPLACED_MESSAGE);
        }

        try {
            const asset = await pickNativePdf();
            if (!asset) {
                setLastEvent('Picker returned no file');
                return;
            }
            console.info(`[mobile-spike] picker returned ${asset.name} from ${asset.backend}: ${asset.uri}`);
            setLastEvent(`Picked via ${asset.backend}`);
            setActiveTransfer(`Importing ${asset.name}`);
            const importedDocument = await importPickedDocument(asset);
            const pendingDocument: TPendingOpenedDocument = {
                documentId: importedDocument.documentId,
                name: importedDocument.name,
                ref: importedDocument.ref,
                size: importedDocument.size,
            };
            nativeDocuments.current.set(importedDocument.ref, {
                name: importedDocument.name,
                servedFileName: importedDocument.servedFileName,
                servedPath: importedDocument.servedPath,
                sourceUri: importedDocument.sourceUri,
                size: importedDocument.size,
                mimeType: importedDocument.mimeType,
            });
            pendingOpenedDocument.current = pendingDocument;

            await probeServedDocumentUrl(importedDocument.readerUrl, importedDocument.size);
            console.info(`[mobile-spike] opening local URL document: ${importedDocument.name} (${importedDocument.size} bytes) at ${importedDocument.readerUrl}`);
            setLastEvent('Opening URL document');
            setActiveTransfer(`Opening ${importedDocument.name}`);
            pendingOpenIntent.current = {
                documentId: importedDocument.documentId,
                acknowledgedGeneration: null,
                attemptCount: 0,
                deliveredGenerations: new Set(),
                message: {
                    type: 'document:open-url',
                    documentId: importedDocument.documentId,
                    ref: importedDocument.ref,
                    url: importedDocument.readerUrl,
                    suggestedName: importedDocument.name,
                    mimeType: importedDocument.mimeType,
                    size: importedDocument.size,
                },
            };
            deliverPendingOpenIntent();
            await waitForDocumentLoaded(importedDocument.documentId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLastEvent('Document read failed');
            setActiveTransfer(null);
            pendingOpenIntent.current = null;
            pendingOpenedDocument.current = null;
            clearOpenIntentRetryTimer();
            if (message !== TRANSFER_REPLACED_MESSAGE) {
                Alert.alert('Could not open document', message);
            }
        }
    }, [
        activeTransfer,
        clearOpenIntentRetryTimer,
        deliverPendingOpenIntent,
        rejectPendingTransfers,
        waitForDocumentLoaded,
    ]);

    const openRecentDocument = useCallback(async (ref: string) => {
        const document = nativeDocuments.current.get(ref);
        if (!document) {
            nativeRecentFiles.current = nativeRecentFiles.current.filter(file => file.originalPath !== ref);
            publishRecentFiles();
            Alert.alert('Recent file unavailable', 'This recent file is no longer available in this mobile session.');
            return;
        }

        if (activeTransfer) {
            console.info(`[mobile-spike] replacing active transfer from recent: ${activeTransfer}`);
            rejectPendingTransfers(TRANSFER_REPLACED_MESSAGE);
        }

        const documentId = `${Date.now()}:${document.name}`;
        const pendingDocument: TPendingOpenedDocument = {
            documentId,
            name: document.name,
            ref,
            size: document.size,
        };
        pendingOpenedDocument.current = pendingDocument;

        try {
            const readerUrl = await getReaderUrlForDocument(document);
            await probeServedDocumentUrl(readerUrl, document.size);
            console.info(`[mobile-spike] reopening local URL recent document: ${document.name} (${document.size} bytes) at ${readerUrl}`);
            setLastEvent('Opening recent document');
            setActiveTransfer(`Opening ${document.name}`);
            pendingOpenIntent.current = {
                documentId,
                acknowledgedGeneration: null,
                attemptCount: 0,
                deliveredGenerations: new Set(),
                message: {
                    type: 'document:open-url',
                    documentId,
                    ref,
                    url: readerUrl,
                    suggestedName: document.name,
                    mimeType: document.mimeType,
                    size: document.size,
                },
            };
            deliverPendingOpenIntent();
            await waitForDocumentLoaded(documentId);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setLastEvent('Recent document read failed');
            setActiveTransfer(null);
            pendingOpenIntent.current = null;
            pendingOpenedDocument.current = null;
            clearOpenIntentRetryTimer();
            if (message !== TRANSFER_REPLACED_MESSAGE) {
                Alert.alert('Could not open recent document', message);
            }
        }
    }, [
        activeTransfer,
        clearOpenIntentRetryTimer,
        deliverPendingOpenIntent,
        getReaderUrlForDocument,
        publishRecentFiles,
        rejectPendingTransfers,
        waitForDocumentLoaded,
    ]);

    useEffect(() => {
        openDocumentRef.current = openDocument;
        openRecentDocumentRef.current = openRecentDocument;
    }, [
        openDocument,
        openRecentDocument,
    ]);

    const executeCommand = useCallback((commandId: TReaderCommandId) => {
        postToViewer({
            type: 'reader:execute-command',
            command: { id: commandId },
        });
        setIsMenuOpen(false);
    }, [postToViewer]);

    const reloadViewer = useCallback(() => {
        beginViewerLoad('Reloading viewer');
        webViewRef.current?.reload();
    }, [beginViewerLoad]);

    return (
        <SafeAreaView style={styles.root}>
            <StatusBar style="dark" />
            <View style={styles.topBar}>
                <Pressable
                    style={styles.button}
                    onPress={() => {
                        void openDocument('native-button');
                    }}
                >
                    <Text style={styles.buttonText}>Open</Text>
                </Pressable>
                <View style={styles.titleBlock}>
                    <Text style={styles.title} numberOfLines={1}>
                        {openedDocument?.name ?? 'EVB mobile spike'}
                    </Text>
                    <Text style={styles.subtitle} numberOfLines={1}>
                        {pageLabel} · {activeTransfer ?? lastEvent}
                    </Text>
                </View>
                <Pressable style={styles.iconButton} onPress={reloadViewer}>
                    <Text style={styles.iconButtonText}>Reload</Text>
                </Pressable>
                <Pressable style={styles.iconButton} onPress={() => setIsMenuOpen(true)}>
                    <Text style={styles.iconButtonText}>Menu</Text>
                </Pressable>
            </View>

            <View style={styles.viewerHost}>
                <WebView
                    ref={webViewRef}
                    source={source}
                    style={styles.webView}
                    originWhitelist={['*']}
                    allowFileAccess
                    allowingReadAccessToURL="file://"
                    javaScriptEnabled
                    domStorageEnabled
                    mixedContentMode="always"
                    injectedJavaScriptBeforeContentLoaded={WEBVIEW_BOOTSTRAP_SCRIPT}
                    onMessage={handleViewerMessage}
                    onLoadStart={() => beginViewerLoad('Loading viewer')}
                    onLoad={() => {
                        setLastEvent('Viewer page loaded');
                        console.info(`[mobile-spike] WebView loaded: ${viewerUrl}`);
                        setTimeout(pingViewer, 0);
                        setTimeout(pingViewer, 500);
                    }}
                    onLoadEnd={() => {
                        setTimeout(pingViewer, 0);
                        setTimeout(pingViewer, 1_000);
                    }}
                    onError={event => {
                        const { code, description } = event.nativeEvent;
                        const message = `${description} (${code})`;
                        console.warn(`[mobile-spike] WebView error: ${message}`);
                        clearViewerPingTimer();
                        clearViewerReadyTimer();
                        setIsViewerReady(false);
                        setIsViewerLoading(false);
                        setLoadError(message);
                        setLastEvent('Viewer load failed');
                        rejectPendingTransfers(message);
                    }}
                    onHttpError={event => {
                        const { statusCode, description } = event.nativeEvent;
                        const message = `${description || 'HTTP error'} (${statusCode})`;
                        console.warn(`[mobile-spike] WebView HTTP error: ${message}`);
                        clearViewerPingTimer();
                        clearViewerReadyTimer();
                        setIsViewerReady(false);
                        setIsViewerLoading(false);
                        setLoadError(message);
                        setLastEvent('Viewer HTTP failed');
                        rejectPendingTransfers(message);
                    }}
                    renderError={() => (
                        <ViewerErrorView
                            message={loadError ?? 'The reader WebView failed to load.'}
                            viewerUrl={viewerUrl}
                            onReload={reloadViewer}
                        />
                    )}
                />
                {isViewerLoading && !loadError ? (
                    <ViewerLoadingView viewerUrl={viewerUrl} />
                ) : null}
                {loadError ? (
                    <ViewerErrorOverlay
                        message={loadError}
                        viewerUrl={viewerUrl}
                        onReload={reloadViewer}
                    />
                ) : null}
            </View>

            <CommandSheet
                visible={isMenuOpen}
                onClose={() => setIsMenuOpen(false)}
                onCommand={executeCommand}
            />
        </SafeAreaView>
    );
}

function ViewerLoadingView({ viewerUrl }: { viewerUrl: string }) {
    return (
        <View style={styles.loadingPanel}>
            <Text style={styles.loadingTitle}>Loading reader</Text>
            <Text style={styles.loadingUrl}>{viewerUrl}</Text>
        </View>
    );
}

function ViewerErrorOverlay({
    message,
    viewerUrl,
    onReload,
}: {
    message: string;
    viewerUrl: string;
    onReload: () => void;
}) {
    return (
        <View style={styles.errorOverlay}>
            <ViewerErrorView
                message={message}
                viewerUrl={viewerUrl}
                onReload={onReload}
            />
        </View>
    );
}

function ViewerErrorView({
    message,
    viewerUrl,
    onReload,
}: {
    message: string;
    viewerUrl: string;
    onReload: () => void;
}) {
    return (
        <View style={styles.errorPanel}>
            <Text style={styles.errorTitle}>Reader unavailable</Text>
            <Text style={styles.errorBody}>{message}</Text>
            <Text style={styles.errorUrl}>{viewerUrl}</Text>
            <Text style={styles.errorHint}>
                Start pnpm dev:web and confirm this address opens from the phone browser.
            </Text>
            <Pressable style={styles.button} onPress={onReload}>
                <Text style={styles.buttonText}>Reload</Text>
            </Pressable>
        </View>
    );
}

function CommandSheet({
    visible,
    onClose,
    onCommand,
}: {
    visible: boolean;
    onClose: () => void;
    onCommand: (command: TReaderCommandId) => void;
}) {
    return (
        <Modal animationType="slide" transparent visible={visible} onRequestClose={onClose}>
            <Pressable style={styles.sheetBackdrop} onPress={onClose} />
            <View style={styles.sheet}>
                <View style={styles.sheetHandle} />
                <Text style={styles.sheetTitle}>Reader commands</Text>
                <ScrollView>
                    {MENU_COMMANDS.map(command => (
                        <Pressable
                            key={command}
                            style={styles.sheetItem}
                            onPress={() => onCommand(command)}
                        >
                            <Text style={styles.sheetItemTitle}>
                                {READER_COMMAND_DESCRIPTORS[command].labelKey}
                            </Text>
                            <Text style={styles.sheetItemMeta}>
                                {READER_COMMAND_DESCRIPTORS[command].category}
                            </Text>
                        </Pressable>
                    ))}
                </ScrollView>
            </View>
        </Modal>
    );
}

const styles = StyleSheet.create({
    root: {
        flex: 1,
        backgroundColor: '#f4f4f5',
    },
    topBar: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 12,
        paddingVertical: 10,
        backgroundColor: '#ffffff',
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#d4d4d8',
    },
    titleBlock: {
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 15,
        fontWeight: '600',
        color: '#27272a',
    },
    subtitle: {
        marginTop: 2,
        fontSize: 12,
        color: '#71717a',
    },
    button: {
        minHeight: 38,
        justifyContent: 'center',
        paddingHorizontal: 14,
        borderRadius: 8,
        backgroundColor: '#075985',
    },
    buttonText: {
        color: '#ffffff',
        fontWeight: '600',
    },
    iconButton: {
        minHeight: 38,
        justifyContent: 'center',
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: '#e4e4e7',
    },
    iconButtonText: {
        color: '#27272a',
        fontWeight: '600',
    },
    viewerHost: {
        flex: 1,
        position: 'relative',
    },
    webView: {
        flex: 1,
        backgroundColor: '#ffffff',
    },
    loadingPanel: {
        ...StyleSheet.absoluteFillObject,
        justifyContent: 'center',
        paddingHorizontal: 24,
        backgroundColor: '#ffffff',
    },
    loadingTitle: {
        marginBottom: 10,
        fontSize: 18,
        fontWeight: '700',
        color: '#27272a',
        textAlign: 'center',
    },
    loadingUrl: {
        padding: 10,
        borderRadius: 8,
        backgroundColor: '#f4f4f5',
        color: '#52525b',
        fontSize: 12,
        textAlign: 'center',
    },
    errorOverlay: {
        ...StyleSheet.absoluteFillObject,
        backgroundColor: '#ffffff',
    },
    errorPanel: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 24,
        backgroundColor: '#ffffff',
    },
    errorTitle: {
        marginBottom: 10,
        fontSize: 22,
        fontWeight: '700',
        color: '#18181b',
        textAlign: 'center',
    },
    errorBody: {
        marginBottom: 12,
        fontSize: 15,
        color: '#52525b',
        textAlign: 'center',
    },
    errorUrl: {
        marginBottom: 12,
        padding: 10,
        borderRadius: 8,
        backgroundColor: '#f4f4f5',
        color: '#27272a',
        fontSize: 13,
        textAlign: 'center',
    },
    errorHint: {
        marginBottom: 18,
        fontSize: 13,
        color: '#71717a',
        textAlign: 'center',
    },
    sheetBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0, 0, 0, 0.18)',
    },
    sheet: {
        maxHeight: '55%',
        paddingHorizontal: 20,
        paddingTop: 8,
        paddingBottom: 24,
        borderTopLeftRadius: 20,
        borderTopRightRadius: 20,
        backgroundColor: '#ffffff',
    },
    sheetHandle: {
        alignSelf: 'center',
        width: 42,
        height: 4,
        marginBottom: 14,
        borderRadius: 2,
        backgroundColor: '#d4d4d8',
    },
    sheetTitle: {
        marginBottom: 8,
        fontSize: 20,
        fontWeight: '700',
        color: '#18181b',
    },
    sheetItem: {
        paddingVertical: 14,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: '#e4e4e7',
    },
    sheetItemTitle: {
        fontSize: 16,
        color: '#27272a',
    },
    sheetItemMeta: {
        marginTop: 2,
        fontSize: 12,
        color: '#71717a',
    },
});
