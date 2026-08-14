"""Task E8 -- patches the Firebase google-services Gradle plugin into the
`android/app/build.gradle.kts` that `flutter create` generates, and verifies
`google-services.json` sits at `android/app/google-services.json` where the
plugin looks for it by default (Google's documented location).

`flutter create` (current stable Flutter, 3.47.0) generates a Kotlin DSL
app-level file whose `plugins {}` block lists versionless plugin ids
(`com.android.application`, `kotlin-android`, `dev.flutter.flutter-gradle-plugin`)
resolved from the settings pluginManagement. The google-services plugin is
applied by version here, matching Google's documented recipe:

    plugins {
        id("com.google.gms.google-services") version "4.4.4"
    }

The anchor is the `dev.flutter.flutter-gradle-plugin` line -- present in
every recent Flutter template, and required to exist by the build anyway.
Like patch_android_signing.py, this fails loudly with the actual file
content rather than guessing a second time if the template ever changes
shape.

google-services.json itself is never committed -- build-apk.yml writes it
from the GOOGLE_SERVICES_JSON repo secret before this script runs.
"""

from __future__ import annotations

import sys

ANCHOR = 'id("dev.flutter.flutter-gradle-plugin")'
PLUGIN_LINE = '    id("com.google.gms.google-services") version "4.4.4"'


def patch(build_gradle_text: str) -> str:
    if ANCHOR not in build_gradle_text:
        raise ValueError(
            "could not find the Flutter Gradle plugin anchor "
            f"`{ANCHOR}` to insert the google-services plugin after -- the "
            "generated build.gradle.kts doesn't match any known shape, "
            "refusing to guess blind.\n"
            f"--- actual file content ---\n{build_gradle_text}"
        )
    if 'com.google.gms.google-services' in build_gradle_text:
        return build_gradle_text

    return build_gradle_text.replace(ANCHOR, ANCHOR + "\n" + PLUGIN_LINE, 1)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: patch_android_firebase.py <path-to-build.gradle.kts>", file=sys.stderr)
        return 1

    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        original = f.read()

    patched = patch(original)

    with open(path, "w", encoding="utf-8") as f:
        f.write(patched)

    print(f"Patched google-services plugin into {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
