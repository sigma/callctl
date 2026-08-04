{
  description = "callctl monorepo dev environment (firefly-engineering/toolbox)";

  inputs = {
    nix-pins.url = "github:firefly-engineering/nix-pins";
    nixpkgs.follows = "nix-pins/nixpkgs";
    toolbox.url = "github:firefly-engineering/toolbox";
    toolbox.inputs.nix-pins.follows = "nix-pins";

    # Pinned Google Noto Color Emoji vector sources (per-glyph SVGs under svg/).
    # Consumed by the reaction-icon generator; see packages/plugin/scripts.
    noto-emoji = {
      url = "github:googlefonts/noto-emoji";
      flake = false;
    };
  };

  outputs =
    { nixpkgs, toolbox, noto-emoji, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          reg = toolbox.registry.${system};

          # Resolve a toolbox package at its default version.
          tool = name: reg.${name}.versions.${reg.${name}.default};
        in
        {
          # typescript-toolchain bundles nodejs, pnpm, typescript, biome and bun
          # (all pinned) — the JS/TS driver for this monorepo. The @elgato/cli
          # `streamdeck` binary and other JS deps come from pnpm, not nix.
          default = pkgs.mkShell {
            packages = [
              (tool "typescript-toolchain")
              (tool "just")
            ];
          };

          # Dedicated shell for the reaction-icon generator
          # (packages/plugin/scripts/gen-react-icons.ts), kept separate so the
          # default shell stays lean: this one pulls the heavy pinned noto-emoji
          # source plus the rasterizers. Used by `just gen-react-icons`.
          icon-gen = pkgs.mkShell {
            packages = [
              (tool "typescript-toolchain") # bun, to run the generator
              pkgs.resvg # rasterize the Noto SVGs
              pkgs.imagemagick # trim / scale / center onto the tile
            ];

            # Pinned Noto Color Emoji SVG source dir, so the generator renders
            # from a locked revision instead of the network.
            NOTO_EMOJI_SVG = "${noto-emoji}/svg";
          };
        }
      );
    };
}
