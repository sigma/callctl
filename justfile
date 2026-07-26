# callctl monorepo task runner.
# Run `just` with no arguments to list all recipes.
# Everything here wraps the pnpm / streamdeck invocations so you don't have to
# remember them. Assumes you're in the nix devShell (direnv `use flake`).

uuid := "dev.yrh.callctl"
plugin_log := "packages/plugin/dev.yrh.callctl.sdPlugin/logs/dev.yrh.callctl.0.log"

# List available recipes
default:
    @just --list

# Install all workspace dependencies
install:
    pnpm install

# Build every package (protocol → plugin, in dependency order)
build:
    pnpm -r build

# Remove build outputs
clean:
    rm -rf packages/*/dist packages/plugin/*.sdPlugin/bin

# --- Plugin (terminal 1) -----------------------------------------------------

# Watch + hot-reload the Stream Deck plugin (rebuild + restart on save)
dev-plugin:
    pnpm -F @callctl/plugin dev

# Link the plugin into Stream Deck (one-time setup)
link:
    pnpm -F @callctl/plugin link

# Validate the plugin manifest + bundle
validate:
    pnpm -F @callctl/plugin validate

# Restart the plugin in Stream Deck
restart:
    pnpm -F @callctl/plugin exec streamdeck restart {{uuid}}

# Tail the plugin log (survives reloads — uses tail -F)
logs:
    tail -F {{plugin_log}}

# --- Extension (terminal 2) --------------------------------------------------

# Watch + HMR the Chrome extension (MV3, Vite + @crxjs)
dev-extension:
    pnpm -F @callctl/extension dev

# Build the unpacked MV3 extension into packages/extension/dist
build-extension:
    pnpm -F @callctl/extension build

# Where to point chrome://extensions "Load unpacked" (after build-extension)
load-extension:
    @echo "Load unpacked extension from: {{justfile_directory()}}/packages/extension/dist"

# --- Dev bridge (Meet DOM debugging) -----------------------------------------
# The bridge exposes the live Meet DOM for introspection/clicking. Its DebugPlugin
# ships only in non-production extension builds (`dev-extension` or the debug
# build), so build the extension in dev/debug mode when using the bridge.

# Build the dev bridge (required before MCP use via .mcp.json)
build-devbridge:
    pnpm -F @callctl/devbridge build

# Debug-only bridge + HTTP API on :2395/:2397 (extension unchanged; Stream Deck
# plugin must NOT be running, since both want :2395). Try: curl localhost:2397/dump?q=hand
dev-bridge:
    pnpm -F @callctl/devbridge start

# Transparent proxy: bridge on :2396 in front of the plugin on :2395, so Stream
# Deck keeps working while you debug. Point the extension's options port at 2396.
dev-bridge-proxy:
    pnpm -F @callctl/devbridge start --extension-port 2396 --plugin-port 2395

# Loadable non-HMR extension build WITH the DebugPlugin (load dist/ unpacked)
build-extension-debug:
    pnpm -F @callctl/extension exec vite build --mode debug

# --- Quality -----------------------------------------------------------------

# Run all unit tests (vitest)
test:
    pnpm -r test

# Format all sources with biome
fmt:
    biome format --write .

# Lint all sources with biome
check:
    biome check .
