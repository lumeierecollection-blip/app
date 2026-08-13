"""Task B7 -- patches release signing into the `android/app/build.gradle`
that `flutter create` generates, using Flutter's own documented signing
recipe (flutter.dev "Sign the app", stable across years of Flutter
releases): read `key.properties`, define a `signingConfigs.release`
block, point the `release` buildType at it instead of the debug keys
`flutter create` wires in by default.

This is the mechanism behind build-apk.yml's fix #1 (never silently fall
back to debug signing): if the generated file doesn't contain the
expected `signingConfig signingConfigs.debug` line to replace, this
script fails loudly rather than leaving debug signing in place
unnoticed. Unverified against a real Flutter-generated build.gradle in
this sandbox (no Flutter SDK available to run `flutter create`) --
proven or corrected by the first real CI run, same as everything else in
this task that needed a live trigger to confirm.
"""

from __future__ import annotations

import sys

KEYSTORE_PROPERTIES_SNIPPET = """\
def keystoreProperties = new Properties()
def keystorePropertiesFile = rootProject.file('key.properties')
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
}

"""

SIGNING_CONFIG_SNIPPET = """
    signingConfigs {
        release {
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
            storeFile keystoreProperties['storeFile'] ? file(keystoreProperties['storeFile']) : null
            storePassword keystoreProperties['storePassword']
        }
    }
"""


def patch(build_gradle_text: str) -> str:
    if "android {" not in build_gradle_text:
        raise ValueError("no 'android {' block found -- not a recognizable Flutter build.gradle")

    text = KEYSTORE_PROPERTIES_SNIPPET + build_gradle_text
    text = text.replace("android {", "android {\n" + SIGNING_CONFIG_SNIPPET, 1)

    replaced = 0
    for debug_ref in ("signingConfig signingConfigs.debug", "signingConfig = signingConfigs.debug"):
        if debug_ref in text:
            release_ref = debug_ref.replace("signingConfigs.debug", "signingConfigs.release")
            text = text.replace(debug_ref, release_ref)
            replaced += text.count(release_ref)

    if replaced == 0:
        raise ValueError(
            "could not find a 'signingConfig signingConfigs.debug' line to replace -- "
            "the generated build.gradle doesn't match the expected shape, refusing to "
            "silently leave debug signing in place"
        )

    return text


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch_android_signing.py <path-to-build.gradle>", file=sys.stderr)
        return 1

    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        original = f.read()

    patched = patch(original)

    with open(path, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"Patched release signing into {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
