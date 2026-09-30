module.exports = {
  packagerConfig: {
    asar: true
  },
  rebuildConfig: {
    onlyModules: []
  },
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        // "loadingGif": "./src/images/loading.gif",
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
