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
import Constants from 'expo-constants';
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
const SMALL_FILE_DIRECT_OPEN_BYTES = 1024 * 1024;
const OPEN_INTENT_RETRY_MS = 900;
const OPEN_INTENT_RETRY_LIMIT = 50;
const TRANSFER_REPLACED_MESSAGE = 'Document open was replaced by another selection.';

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
    uri: string;
    size: number;
}

interface INativeDocumentSource {
    name: string;
    uri: string;
    size: number;
    mimeType: string;
}

type TPendingOpenedDocument = IOpenedDocument;

interface IOpenIntent {
    documentId: string;
    message: Extract<THostToViewerMessage, { type: 'document:open' | 'document:open-ranged' }>;
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

export default function App() {
    const webViewRef = useRef<WebView>(null);
    const pendingMessages = useRef<THostToViewerMessage[]>([]);
    const documentLoadResolvers = useRef(new Map<string, IDeferred<void>>());
    const nativeDocuments = useRef(new Map<string, INativeDocumentSource>());
    const openDocumentRef = useRef<((trigger: TOpenTrigger) => Promise<void>) | null>(null);
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
                ? await LegacyFileSystem.readAsStringAsync(document.uri, {
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
        if (message.type === 'viewer:ready') {
            console.info('[mobile-spike] viewer:ready');
            clearViewerPingTimer();
            clearViewerReadyTimer();
            setIsViewerLoading(false);
            setLoadError(null);
            setIsViewerReady(true);
            flushPendingMessages();
            deliverPendingOpenIntent();
            return;
        }
        if (message.type === 'document:loaded') {
            setPageLabel(`1 / ${message.pageCount}`);
            if (message.documentId) {
                const pendingDocument = pendingOpenedDocument.current;
                if (pendingDocument?.documentId === message.documentId) {
                    setOpenedDocument(pendingDocument);
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
        rejectPendingTransfers,
        respondWithDocumentRange,
        resolveDocumentLoaded,
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

            const selectedFile = asset.file ?? new ExpoFile(asset.uri);
            const size = asset.size ?? selectedFile.size;
            if (!size || size <= 0) {
                throw new Error('The selected file could not be read or its size is unknown.');
            }

            const documentId = `${Date.now()}:${asset.name}`;
            const documentRef = `rn://document/${encodeURIComponent(documentId)}`;
            const pendingDocument: TPendingOpenedDocument = {
                documentId,
                name: asset.name,
                uri: asset.uri,
                size,
            };
            nativeDocuments.current.set(documentRef, {
                name: asset.name,
                uri: asset.uri,
                size,
                mimeType: asset.mimeType,
            });
            pendingOpenedDocument.current = pendingDocument;

            if (size > 0 && size <= SMALL_FILE_DIRECT_OPEN_BYTES) {
                console.info(`[mobile-spike] opening small document directly: ${asset.name} (${size} bytes)`);
                setLastEvent('Reading small document');
                setActiveTransfer(`Reading ${asset.name}`);
                const base64 = await selectedFile.base64();
                setLastEvent('Opening small document');
                setActiveTransfer(`Opening ${asset.name}`);
                pendingOpenIntent.current = {
                    documentId,
                    acknowledgedGeneration: null,
                    attemptCount: 0,
                    deliveredGenerations: new Set(),
                    message: {
                        type: 'document:open',
                        documentId,
                        ref: documentRef,
                        suggestedName: asset.name,
                        mimeType: asset.mimeType,
                        size,
                        base64,
                    },
                };
                deliverPendingOpenIntent();
                await waitForDocumentLoaded(documentId);
                return;
            }

            console.info(`[mobile-spike] opening ranged document: ${asset.name} (${size} bytes)`);
            setLastEvent('Opening ranged document');
            setActiveTransfer(`Opening ${asset.name}`);
            pendingOpenIntent.current = {
                documentId,
                acknowledgedGeneration: null,
                attemptCount: 0,
                deliveredGenerations: new Set(),
                message: {
                    type: 'document:open-ranged',
                    documentId,
                    ref: documentRef,
                    suggestedName: asset.name,
                    mimeType: asset.mimeType,
                    size,
                },
            };
            deliverPendingOpenIntent();
            await waitForDocumentLoaded(documentId);
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

    useEffect(() => {
        openDocumentRef.current = openDocument;
    }, [openDocument]);

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
                    onMessage={handleViewerMessage}
                    onLoadStart={() => beginViewerLoad('Loading viewer')}
                    onLoad={() => {
                        setLastEvent('Viewer page loaded');
                        console.info(`[mobile-spike] WebView loaded: ${viewerUrl}`);
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
