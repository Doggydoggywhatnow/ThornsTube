// Renderer build for the Tauri shell. Reuses the Electron renderer config so
// upstream changes to it are picked up automatically; only the differences
// needed for Tauri are overridden here.
const path = require('path')
const rendererConfig = require('./webpack.renderer.config')

/** @type {import('webpack').Configuration} */
const config = {
  ...rendererConfig,
  name: 'tauri',
  entry: {
    renderer: [
      path.join(__dirname, '../src/tauri/ftElectron.js'),
      ...[].concat(rendererConfig.entry.renderer)
    ]
  },
  output: {
    ...rendererConfig.output,
    path: path.join(__dirname, '../dist-tauri')
  },
  resolve: {
    ...rendererConfig.resolve,
    alias: {
      ...rendererConfig.resolve.alias,
      // Electron's handlers talk to nedb in the main process; use the browser storage ones.
      DB_HANDLERS_ELECTRON_RENDERER_OR_WEB$: path.resolve(__dirname, '../src/datastores/handlers/web.js')
    }
  }
}

module.exports = config
