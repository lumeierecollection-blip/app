"""Tests for scripts/patch_android_signing.py against a synthetic
build.gradle.kts matching what Flutter's `flutter create` actually
generated in the first real CI run of this task (2026-08-13, Flutter
stable 3.47.0) -- Kotlin DSL, not Groovy. Still synthetic (reconstructed
from the documented flutter.dev Kotlin DSL signing recipe, not a byte
-for-byte copy of the real generated file, which this sandbox has no
Flutter SDK to produce), flagged as such for that reason.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from patch_android_signing import patch

SYNTHETIC_BUILD_GRADLE_KTS = """\
plugins {
    id("com.android.application")
    id("kotlin-android")
    id("dev.flutter.flutter-gradle-plugin")
}

android {
    namespace = "com.tipsteraggregator.tipster_aggregator"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    defaultConfig {
        applicationId = "com.tipsteraggregator.tipster_aggregator"
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

flutter {
    source = "../.."
}
"""


def test_patch_inserts_imports():
    result = patch(SYNTHETIC_BUILD_GRADLE_KTS)
    assert "import java.util.Properties" in result
    assert "import java.io.FileInputStream" in result


def test_patch_inserts_keystore_properties_loader():
    result = patch(SYNTHETIC_BUILD_GRADLE_KTS)
    assert 'val keystoreProperties = Properties()' in result
    assert 'rootProject.file("key.properties")' in result


def test_patch_inserts_signing_configs_block_inside_android():
    result = patch(SYNTHETIC_BUILD_GRADLE_KTS)
    android_index = result.index("android {")
    signing_index = result.index("signingConfigs {")
    assert signing_index > android_index
    assert 'create("release")' in result
    assert 'keystoreProperties["keyAlias"]' in result


def test_patch_repoints_release_build_type_at_release_signing():
    result = patch(SYNTHETIC_BUILD_GRADLE_KTS)
    assert 'signingConfig = signingConfigs.getByName("release")' in result
    assert 'signingConfig = signingConfigs.getByName("debug")' not in result


def test_patch_handles_single_quote_variant():
    variant = SYNTHETIC_BUILD_GRADLE_KTS.replace(
        'signingConfig = signingConfigs.getByName("debug")',
        "signingConfig = signingConfigs.getByName('debug')",
    )
    result = patch(variant)
    assert 'signingConfig = signingConfigs.getByName("release")' in result


def test_patch_handles_bare_property_reference_variant():
    variant = SYNTHETIC_BUILD_GRADLE_KTS.replace(
        'signingConfig = signingConfigs.getByName("debug")',
        "signingConfig = signingConfigs.debug",
    )
    result = patch(variant)
    assert 'signingConfig = signingConfigs.getByName("release")' in result


def test_patch_does_not_duplicate_imports_if_already_present():
    already_has_imports = "import java.util.Properties\nimport java.io.FileInputStream\n\n" + SYNTHETIC_BUILD_GRADLE_KTS
    result = patch(already_has_imports)
    assert result.count("import java.util.Properties") == 1


def test_patch_fails_loudly_on_unrecognized_shape():
    with pytest.raises(ValueError):
        patch("this is not a build.gradle.kts at all")


def test_patch_fails_loudly_when_no_debug_signing_reference_found():
    no_debug_ref = SYNTHETIC_BUILD_GRADLE_KTS.replace(
        'signingConfig = signingConfigs.getByName("debug")', "// nothing here"
    )
    with pytest.raises(ValueError):
        patch(no_debug_ref)


def test_patch_error_includes_actual_file_content_for_diagnosis():
    with pytest.raises(ValueError, match="actual file content"):
        patch("this is not a build.gradle.kts at all")
