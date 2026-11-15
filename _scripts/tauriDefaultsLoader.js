// Build-time tweak for the Tauri build: default to the Invidious backend, because the Local API
// currently needs a PO token that WebKit-based webviews cannot obtain (see README).
// Done as a loader so src/renderer/store/modules/settings.js stays identical to upstream FreeTube.
// Users who already chose a backend keep their choice (this only changes the default).
const FROM = "backendPreference: !process.env.SUPPORTS_LOCAL_API ? 'invidious' : 'local'"

module.exports = function (source) {
  if (!source.includes(FROM)) {
    throw new Error('tauriDefaultsLoader: upstream changed the backendPreference default in settings.js; update _scripts/tauriDefaultsLoader.js')
  }

  return source.replace(FROM, "backendPreference: 'invidious'")
}
