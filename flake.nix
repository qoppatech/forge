{
  description = "FORGE local development tools (no deployment)";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/ef34387ddd751e1ab8857adf4676492d32eb24ec";

  outputs =
    { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        # cargo-build-sbf imports <nixpkgs> when patching its NixOS ELF dependencies.
        NIX_PATH = "nixpkgs=${nixpkgs.outPath}";
        packages = with pkgs; [
          bun
          nodejs_24
          postgresql_17
          anchor
          solana-cli
          cargo
          rustc
          rustfmt
          clippy
          pkg-config
          openssl
        ];
        shellHook = ''
          export PATH="$PWD/.tools/bin:$PATH"
          export XDG_CACHE_HOME="$PWD/.cache"
        '';
      };
    };
}
