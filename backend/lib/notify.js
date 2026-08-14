/**
 * Amendment E -- FCM push (Task E6). Two layers:
 *
 *  - createNotifier({ send }): the shape the pipeline consumes -- one
 *    sendNotification(payload) call per (notification, device) pair.
 *    Tests inject a fake `send`.
 *  - createFcmNotifier(serviceAccountJson): the real thing, built on
 *    firebase-admin, loaded lazily on first send so a server with no
 *    FIREBASE_SERVICE_ACCOUNT_JSON configured still boots and runs every
 *    other function (notifications just get queued and then skipped when
 *    no devices are registered).
 *
 * firebase-admin is a singleton; lazy dynamic import + `if (admin.apps.length
 * === 0)` is the standard way to initialize it exactly once.
 */

export function createNotifier({ send }) {
  if (typeof send !== 'function') throw new Error('createNotifier requires a send function');
  return {
    sendNotification: async (payload) => send(payload),
  };
}

export function createFcmNotifier(serviceAccountJson) {
  let messaging = null;
  return createNotifier({
    send: async ({ token, title, body, data }) => {
      if (!messaging) {
        const admin = await import('firebase-admin/app');
        if (admin.getApps().length === 0) {
          admin.initializeApp({ credential: admin.cert(JSON.parse(serviceAccountJson)) });
        }
        const messagingModule = await import('firebase-admin/messaging');
        messaging = messagingModule.getMessaging();
      }
      await messaging.send({
        token,
        notification: { title, body },
        data: data ?? {},
      });
    },
  });
}
