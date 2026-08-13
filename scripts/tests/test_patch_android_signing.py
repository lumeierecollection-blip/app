"""Tests for scripts/patch_android_signing.py against a synthetic
build.gradle matching Flutter's own documented default shape (the
`flutter create` template has looked like this across recent stable
releases) -- not a real captured file, since no Flutter SDK is available
in this sandbox to generate one; flagged as synthetic for that reason.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from patch_android_signing import patch

SYNTHETIC_BUILD_GRADLE = """\
plugins {
    id "com.android.application"
    id "kotlin-android"
    id "dev.flutter.flutter-gradle-plugin"
}

android {
    namespace "com.tipsteraggregator.tipster_aggregator"
    compileSdk flutter.compileSdkVersion

    defaultConfig {
        applicationId "com.tipsteraggregator.tipster_aggregator"
        minSdkVersion flutter.minSdkVersion
        targetSdkVersion flutter.targetSdkVersion
        versionCode flutterVersionCode.toInteger()
        versionName flutterVersionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig signingConfigs.debug
        }
    }
}

flutter {
    source '../..'
}
"""


def test_patch_inserts_keystore_properties_loader():
    result = patch(SYNTHETIC_BUILD_GRADLE)
    assert "def keystoreProperties = new Properties()" in result
    assert "rootProject.file('key.properties')" in result


def test_patch_inserts_signing_configs_block_inside_android():
    result = patch(SYNTHETIC_BUILD_GRADLE)
    android_index = result.index("android {")
    signing_index = result.index("signingConfigs {")
    assert signing_index > android_index
    assert "keystoreProperties['keyAlias']" in result


def test_patch_repoints_release_build_type_at_release_signing():
    result = patch(SYNTHETIC_BUILD_GRADLE)
    assert "signingConfig signingConfigs.release" in result
    assert "signingConfig signingConfigs.debug" not in result


def test_patch_handles_equals_sign_variant():
    variant = SYNTHETIC_BUILD_GRADLE.replace(
        "signingConfig signingConfigs.debug", "signingConfig = signingConfigs.debug"
    )
    result = patch(variant)
    assert "signingConfig = signingConfigs.release" in result


def test_patch_fails_loudly_on_unrecognized_shape():
    with pytest.raises(ValueError):
        patch("this is not a build.gradle at all")


def test_patch_fails_loudly_when_no_debug_signing_reference_found():
    no_debug_ref = SYNTHETIC_BUILD_GRADLE.replace("signingConfig signingConfigs.debug", "// nothing here")
    with pytest.raises(ValueError):
        patch(no_debug_ref)
