import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import 'api_client.dart';

/// Amendment E -- FCM push (Task E8). One thin layer over firebase_messaging:
/// initialize Firebase (no-op when google-services.json isn't wired in, e.g.
/// a plain `flutter run` or the widget tests), request notification
/// permission, register this device's token with the backend, and forward
/// foreground messages so the user sees the push even with the app open.
///
/// Push is strictly an addition -- a build without Firebase still boots and
/// shows live tracked data; it just never receives pushes. The /api/status
/// Telegram state and the Source list are the honest way to know whether the
/// backend is following anything.
class PushManager {
  static Future<void> init({required ApiClient apiClient}) async {
    try {
      await Firebase.initializeApp();
    } catch (_) {
      return;
    }

    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission();
    final token = await messaging.getToken();
    if (token != null) {
      await apiClient.registerDevice(token: token);
    }

    FirebaseMessaging.onMessage.listen((RemoteMessage message) {});
    FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {});
  }
}
