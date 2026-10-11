{
  description = "Nuvio Live Sports add-on";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, bun2nix }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system} bun2nix.packages.${system}.default);
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
    in
    {
      packages = forAllSystems (pkgs: b2n:
        let
          inherit (pkgs) lib stdenv;
          nodejs = pkgs.nodejs-slim_22;
          fs = lib.fileset;

          app = stdenv.mkDerivation {
            pname = "live-sport-plugin";
            inherit (packageJson) version;

            src = fs.toSource {
              root = ./.;
              fileset = fs.unions [ ./package.json ./bun.lock ./bunfig.toml ./src ./public ];
            };

            nativeBuildInputs = [ b2n.hook pkgs.makeWrapper ]
              ++ lib.optionals stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
            # impit ships a prebuilt N-API addon linked against libgcc_s.
            buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

            bunDeps = b2n.fetchBunDeps { bunNix = ./bun.nix; };
            bunInstallFlags = [ "--production" "--linker=hoisted" ]
              # clonefile cannot read out of the nix store on darwin.
              ++ lib.optionals stdenv.hostPlatform.isDarwin [ "--backend=copyfile" ];

            dontUseBunPatch = true;
            dontUseBunBuild = true;
            dontUseBunCheck = true;

            installPhase = ''
              runHook preInstall
              share=$out/share/live-sport-plugin
              mkdir -p $share
              # bun filters optional deps by os/cpu but not libc; nixpkgs is glibc,
              # and autoPatchelf cannot satisfy the musl addon.
              rm -rf node_modules/impit-linux-*-musl
              cp -r package.json src public node_modules $share/
              makeWrapper ${lib.getExe nodejs} $out/bin/live-sport-plugin \
                --add-flags $share/src/index.js \
                --prefix PATH : ${lib.makeBinPath [ nodejs ]} \
                --set-default NODE_ENV production
              runHook postInstall
            '';

            meta = {
              description = packageJson.description;
              license = lib.licenses.mit;
              mainProgram = "live-sport-plugin";
              platforms = systems;
            };
          };
        in
        {
          default = app;
          live-sport-plugin = app;
        });

      apps = forAllSystems (pkgs: _: {
        default = {
          type = "app";
          program = nixpkgs.lib.getExe self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          meta.description = packageJson.description;
        };
      });

      devShells = forAllSystems (pkgs: b2n: {
        default = pkgs.mkShell {
          packages = [ pkgs.nodejs_22 pkgs.bun b2n ];
        };
      });
    };
}
