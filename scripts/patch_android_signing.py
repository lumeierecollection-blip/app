"""Task B7 -- patches release signing into the `android/app/build.gradle.kts`
that `flutter create` generates, using Flutter's own documented signing
recipe (flutter.dev "Sign the app", Kotlin DSL variant): read
`key.properties`, define a `signingConfigs { create("release") { ... } }`
block, point the `release` buildType at it instead of the debug keys
`flutter create` wires in by default.

**Kotlin DSL, not Groovy.** The first real CI run of this workflow
(2026-08-13) confirmed `flutter create` on current stable Flutter
(3.47.0) generates `android/app/build.gradle.kts`, not the Groovy
`build.gradle` this script originally targeted -- that assumption was
wrong and only correctable once a real generated file existed to check
against, which nothing in this sandbox (no Flutter SDK) could produce.
Rewritten for Kotlin DSL syntax as a result.

**Ordering matters in Kotlin DSL** (a second real bug the same live run
caught): imports must precede every other top-level statement, and
Gradle additionally requires the `plugins { ... }` block to be the first
statement after any imports/comments. The `keystoreProperties` loader
therefore can't be prepended to the very top of the file alongside the
imports -- it has to land *after* the original `plugins {}` block, right
before `android {`. An earlier version of this script prepended both
blocks to the front in two separate steps, which silently reversed their
order and put executable code before the imports; Gradle's Kotlin
compiler rejected it with "Expecting an element" at the `import` lines.

This is the mechanism behind build-apk.yml's fix #1 (never silently fall
back to debug signing): if the generated file doesn't contain a
recognizable `signingConfig = signingConfigs.getByName("debug")` (or
equivalent) line to replace, this script fails loudly and prints the
actual file content, rather than leaving debug signing in place
unnoticed or guessing blind a second time.
"""

from __future__ import annotations

import sys

IMPORTS_SNIPPET = """\
import java.util.Properties
import java.io.FileInputStream

"""

KEYSTORE_PROPERTIES_SNIPPET = """
val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("key.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

"""

SIGNING_CONFIG_SNIPPET = """
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["keyPassword"] as String
            storeFile = keystoreProperties["storeFile"]?.let { file(it) }
            storePassword = keystoreProperties["storePassword"] as String
        }
    }
"""

# Known shapes of the release buildType's default (debug-signed) line
# across recent Flutter Kotlin DSL templates -- tried in order, first
# match wins.
DEBUG_SIGNING_PATTERNS = [
    'signingConfig = signingConfigs.getByName("debug")',
    "signingConfig = signingConfigs.getByName('debug')",
    "signingConfig = signingConfigs.debug",
]


def patch(build_gradle_text: str) -> str:
    if "android {" not in build_gradle_text:
        raise ValueError(
            "no 'android {' block found -- not a recognizable Flutter build.gradle.kts.\n"
            f"--- actual file content ---\n{build_gradle_text}"
        )

    text = build_gradle_text
    if "import java.util.Properties" not in text:
        text = IMPORTS_SNIPPET + text
    # The keystoreProperties loader must come after the plugins {} block
    # (Gradle requires plugins {} to be the first statement other than
    # imports/comments), so it's inserted immediately before "android {"
    # -- never prepended to the top of the file alongside the imports.
    text = text.replace(
        "android {", KEYSTORE_PROPERTIES_SNIPPET + "android {\n" + SIGNING_CONFIG_SNIPPET, 1
    )

    for debug_pattern in DEBUG_SIGNING_PATTERNS:
        if debug_pattern in text:
            release_line = 'signingConfig = signingConfigs.getByName("release")'
            text = text.replace(debug_pattern, release_line)
            return text

    raise ValueError(
        "could not find a recognizable debug-signing line "
        f"(tried: {DEBUG_SIGNING_PATTERNS}) to replace -- the generated "
        "build.gradle.kts doesn't match any known shape, refusing to "
        "silently leave debug signing in place.\n"
        f"--- actual file content ---\n{build_gradle_text}"
    )


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch_android_signing.py <path-to-build.gradle.kts>", file=sys.stderr)
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
