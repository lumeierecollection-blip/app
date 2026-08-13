import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// App-level settings, including the in-app "Reduce transparency" toggle
/// docs/DESIGN.md §11.3a/§11.4 requires: Flutter has no OS-level signal
/// for `prefers-reduced-transparency` (unlike reduce-motion and
/// high-contrast, which `MediaQuery` exposes directly), so every
/// `BackdropFilter` surface needs to read this and fall back to solid.
/// Default off.
class AppSettings extends ChangeNotifier {
  static const _reduceTransparencyKey = 'reduce_transparency';

  bool _reduceTransparency = false;
  bool get reduceTransparency => _reduceTransparency;

  Future<void> load() async {
    final prefs = await SharedPreferences.getInstance();
    _reduceTransparency = prefs.getBool(_reduceTransparencyKey) ?? false;
    notifyListeners();
  }

  Future<void> setReduceTransparency(bool value) async {
    _reduceTransparency = value;
    notifyListeners();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setBool(_reduceTransparencyKey, value);
  }
}
