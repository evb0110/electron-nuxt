const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');
const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
    path.resolve(projectRoot, 'node_modules'),
    path.resolve(workspaceRoot, 'node_modules'),
];

config.resolver.extraNodeModules = {
    '@evb/contracts': path.resolve(workspaceRoot, 'packages/contracts'),
    expo: path.resolve(projectRoot, 'node_modules/expo'),
    'expo-constants': path.resolve(projectRoot, 'node_modules/expo-constants'),
    'expo-modules-core': path.resolve(projectRoot, 'node_modules/expo-modules-core'),
    react: path.resolve(projectRoot, 'node_modules/react'),
    'react-native': path.resolve(projectRoot, 'node_modules/react-native'),
    'react-native-safe-area-context': path.resolve(projectRoot, 'node_modules/react-native-safe-area-context'),
    'react-native-webview': path.resolve(projectRoot, 'node_modules/react-native-webview'),
};

module.exports = config;
