// Renderer build for the Tauri shell. Reuses the Electron renderer config so
// upstream changes to it are picked up automatically; only the differences
// needed for Tauri are overridden here.
const path = require('path')
const HtmlWebpackPlugin = require('html-webpack-plugin')
const rendererConfig = require('./webpack.renderer.config')
const ProcessLocalesPlugin = require('./ProcessLocalesPlugin')

// index.html must only load the renderer; the BotGuard frame script is loaded by the sandboxed iframe
const plugins = rendererConfig.plugins.map((plugin) => {
  if (plugin instanceof ProcessLocalesPlugin) {
    // The renderer requests `<locale>.json.br` in production Electron builds, where the main
    // process decompresses it (src/main/index.js). Tauri's asset protocol does not, so keep
    // the file names but store plain JSON in them (Tauri compresses embedded assets itself).
    plugin.compressLocale = async (data) => Buffer.from(data)
  }

  if (plugin instanceof HtmlWebpackPlugin) {
    return new HtmlWebpackPlugin({ ...plugin.userOptions, chunks: ['renderer'] })
  }
  return plugin
})

/** @type {import('webpack').Configuration} */
const config = {
  ...rendererConfig,
  name: 'tauri',
  entry: {
    renderer: [
      path.join(__dirname, '../src/tauri/ftElectron.js'),
      ...[].concat(rendererConfig.entry.renderer)
    ],
    // Executed inside the sandboxed iframe that generates PO tokens
    botGuardFrame: path.join(__dirname, '../src/tauri/botGuardFrame.js')
  },
  module: {
    ...rendererConfig.module,
    rules: [
      {
        test: /store[\\/]modules[\\/]settings\.js$/,
        enforce: 'pre',
        loader: path.join(__dirname, 'tauriDefaultsLoader.js')
      },
      ...rendererConfig.module.rules
    ]
  },
  plugins,
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
