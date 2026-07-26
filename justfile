# meetdeck monorepo task runner.
# Run `just` with no arguments to list all recipes.
# Everything here wraps the pnpm / streamdeck invocations so you don't have to
# remember them. Assumes you're in the nix devShell (direnv `use flake`).

uuid := "dev.yrh.meetdeck"
plugin_log := "packages/plugin/dev.yrh.meetdeck.sdPlugin/logs/dev.yrh.meetdeck.0.log"

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
    pnpm -F @meetdeck/plugin dev

# Link the plugin into Stream Deck (one-time setup)
link:
    pnpm -F @meetdeck/plugin link

# Validate the plugin manifest + bundle
validate:
    pnpm -F @meetdeck/plugin validate

# Restart the plugin in Stream Deck
restart:
    pnpm -F @meetdeck/plugin exec streamdeck restart {{uuid}}

# Tail the plugin log (survives reloads — uses tail -F)
logs:
    tail -F {{plugin_log}}

# --- Extension (terminal 2) --------------------------------------------------

# Watch + HMR the Chrome extension (available after the phase-4 MV3 migration)
dev-extension:
    pnpm -F @meetdeck/extension dev

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
