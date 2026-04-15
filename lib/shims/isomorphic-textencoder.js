// Shim for isomorphic-textencoder — use native TextEncoder/TextDecoder
// which are available in all modern browsers and Chrome service workers.
// This replaces the upstream package that crashes in service worker
// strict mode due to fast-text-encoding's broken scope detection.
module.exports = {
  encode: (string) => new TextEncoder().encode(string),
  decode: (buffer) => new TextDecoder().decode(buffer),
};
