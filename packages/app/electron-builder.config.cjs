// electron-builder config for Axo (modelled on Groove's packages/desktop).
// Everything the app runs is pre-bundled (main.cjs, preload.cjs, axo-node.mjs, ui/), so
// no node_modules ship and no symlink stripping is needed before codesign.
//
// Signing / notarization stay off unless credentials are present:
//   sign:      a "Developer ID Application" identity in the keychain, or CSC_LINK (+ CSC_KEY_PASSWORD)
//   notarize:  APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER,
//              or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID,
//              or APPLE_KEYCHAIN_PROFILE
// Unsigned builds are ad-hoc signed (arm64 needs that to launch); Gatekeeper will ask once.

const env = process.env;
const notarize = !!(
  (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) ||
  (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) ||
  env.APPLE_KEYCHAIN_PROFILE
);
const sign = !!env.CSC_LINK || env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'ai.axomlabs.axo',
  productName: 'Axo',
  copyright: 'Axom Labs',
  asar: true,
  directories: { output: 'release', buildResources: 'build' },
  files: ['dist/main.cjs', 'dist/preload.cjs', 'package.json'],
  // Paths the main process expects when app.isPackaged (see main.ts).
  extraResources: [
    { from: '../core/dist/axo-node.mjs', to: 'axo-node.mjs' },
    { from: '../core/dist/axo-node.json', to: 'axo-node.json' },
    { from: '../ui/dist', to: 'ui' },
  ],
  artifactName: 'Axo-${version}-${arch}.${ext}',
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    category: 'public.app-category.developer-tools',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // null = skip identity lookup entirely (ad-hoc signature).
    ...(sign ? {} : { identity: null }),
    notarize,
  },
  dmg: {
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },
  // For electron-updater later; publishing only happens with an explicit --publish.
  publish: { provider: 'github', owner: 'devchef87', repo: 'Axo-Agent-IDE' },
};
