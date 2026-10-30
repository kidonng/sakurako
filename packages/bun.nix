{
  lib,
  stdenvNoCC,
  fetchurl,
  autoPatchelfHook,
  openssl,
}:

let
  version = "1.4.4";
  sources = {
    "aarch64-darwin" = {
      pkg = "bun-darwin-aarch64";
      hash = "sha512-zW/hxwc8sJAILGwB5eTC4i48ouGXf0V4lrxmEOk3JIE6JkYVW1TZh1E2pIempqsezgW1sckTIIDudFON8bJ2Mw==";
    };
    "aarch64-linux" = {
      pkg = "bun-linux-aarch64";
      hash = "sha512-ZTVtpf9zmHSBVPX1sBwe5agGb/rN34yPGg/Hby8e2Ax2uCUA2URZKlZH7qLntK7qaFJCMXh9v0GWNYN2zINz1w==";
    };
    "x86_64-linux" = {
      pkg = "bun-linux-x64";
      hash = "sha512-CHbbkmHVM28T1GFq+6GL4Ao4ujwwYwj1CxFFwEFzLanPfNsId9AhbIP0Q4reWuWBkGimUkoQygrK7Rgjtj3vog==";
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
