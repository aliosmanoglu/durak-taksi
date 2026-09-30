// Metro, pnpm monorepo için: `@duraknet/shared` TS kaynağı olarak (derlemesiz) tüketilir.
// pnpm paketleri sembolik bağlarla kurar; Metro bunları izleyebilmek için çalışma alanı kökünü görmelidir.
// Sembolik bağ ve package exports desteği Metro/Expo varsayılanıdır (expo-doctor ezilmesini istemez).
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = Array.from(new Set([...(config.watchFolders ?? []), workspaceRoot]));
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

module.exports = config;
