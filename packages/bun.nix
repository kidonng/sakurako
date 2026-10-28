{
  lib,
  stdenvNoCC,
  fetchurl,
  autoPatchelfHook,
  openssl,
}:

let
  version = "1.4.4-canary.20261027.1";
  sources = {
    "aarch64-darwin" = {
      pkg = "bun-darwin-aarch64";
      hash = "sha512-dqZdGRW4YNqBn/+KqzgUnbe1zB+vk9eI/eV1o13cXLGfMk8o3dpAvBX4HlyJHm1RumQ/zM9AQjFsQH0BlEj34A==";
    };
    "aarch64-linux" = {
      pkg = "bun-linux-aarch64";
      hash = "sha512-OQ25Ma34Vsa6tuTJ/ilkXTPBakbP6XbgW2AM/Yy3s26IlgCEfGbK4ZYmza+4y3WRzMLHPje4yUMPZ+lHpB+7Yw==";
    };
    "x86_64-linux" = {
      pkg = "bun-linux-x64";
      hash = "sha512-GTKkejc85y2PEelaq9DJnbwJaVfDjJYR8bFKCeUnnbq4s/dWJFv602rp8FW/CnkxNQ/3RKUjB+lk4DTJ87cU5g==";
    };
  };
  source =
    sources.${stdenvNoCC.hostPlatform.system}
      or (throw "Unsupported system: ${stdenvNoCC.hostPlatform.system}");
in
stdenvNoCC.mkDerivation {
  pname = "bun";
  inherit version;

  src = fetchurl {
    url = "https://registry.npmjs.org/@oven/${source.pkg}/-/${source.pkg}-${version}.tgz";
    inherit (source) hash;
  };

  nativeBuildInputs = lib.optionals stdenvNoCC.hostPlatform.isLinux [
    autoPatchelfHook
  ];

  buildInputs = lib.optionals stdenvNoCC.hostPlatform.isLinux [
    openssl
  ];

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    install -Dm 755 bin/bun $out/bin/bun
    ln -s bun $out/bin/bunx
    runHook postInstall
  '';

  meta = {
    homepage = "https://bun.sh";
    description = "Incredibly fast JavaScript runtime, bundler, transpiler and package manager";
    mainProgram = "bun";
  };
}
