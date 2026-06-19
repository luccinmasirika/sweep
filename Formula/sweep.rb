# Homebrew formula for sweep. Builds from source, so Gatekeeper accepts it
# without notarization. Copy this into a `homebrew-tap` repo to publish a tap,
# then: `brew install luccinmasirika/tap/sweep`.
#
# On each release, bump `url` to the new tag and set `sha256` to the tarball's
# checksum: `curl -sL <url> | shasum -a 256`.
class Sweep < Formula
  desc "Safe, interactive disk cleanup for macOS"
  homepage "https://github.com/luccinmasirika/sweep"
  url "https://github.com/luccinmasirika/sweep/archive/refs/tags/v0.1.0.tar.gz"
  sha256 "REPLACE_WITH_TARBALL_SHA256"
  license "MIT"
  head "https://github.com/luccinmasirika/sweep.git", branch: "master"

  depends_on "rust" => :build

  def install
    system "cargo", "install", *std_cargo_args
  end

  test do
    assert_match "cleanup", shell_output("#{bin}/sweep --help")
  end
end
