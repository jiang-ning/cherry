module.exports = {
  packagerConfig: {
    // tesseract.js starts its own worker thread and reads WebAssembly and language files, which must be real files.
    asar: { unpack: '**/node_modules/{tesseract.js,tesseract.js-core,@tesseract.js-data}/**' },
    icon: './src/images/logo.ico'
  },
  rebuildConfig: {
    onlyModules: []
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        "loadingGif": "./src/images/installer-splash.gif",
        "setupIcon": "./src/images/logo.ico"
      }
    },
    { name: '@electron-forge/maker-zip', platforms: ['darwin'] },
    { name: '@electron-forge/maker-deb', config: {} },
    { name: '@electron-forge/maker-rpm', config: {} }
  ],
  plugins: [
    // Native .node binaries such as better-sqlite3 connot load from inside the asar archive.
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} }
  ]
};
