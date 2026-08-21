import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/settings.dart';
import '../theme/type.dart';

/// docs/DESIGN.md §11.8 screen 6. Amendment F makes this the control room
/// for tradeapp's model: the followed Telegram channels (scanned on-device)
/// and the optional cloud backend URL (server-side parsing/scoring/push),
/// plus the §11.3a/§11.4 "Reduce transparency" setting.
class AdminScreen extends StatefulWidget {
  const AdminScreen({super.key});

  @override
  State<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends State<AdminScreen> {
  late final TextEditingController _channelsController;
  late final TextEditingController _cloudController;

  @override
  void initState() {
    super.initState();
    final settings = context.read<AppSettings>();
    _channelsController = TextEditingController(text: settings.telegramChannels.join(', '));
    _cloudController = TextEditingController(text: settings.cloudUrl);
  }

  @override
  void dispose() {
    _channelsController.dispose();
    _cloudController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<AppSettings>();
    return Scaffold(
      appBar: AppBar(title: const Text('Admin')),
      body: ListView(
        children: [
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Text('Telegram channels', style: AppType.label),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              controller: _channelsController,
              decoration: const InputDecoration(
                hintText: 'channel1, channel2  (public usernames, no @)',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Text(
              'Scanned directly from t.me/s on this device. Check a channel in a browser '
              'first — if its posts are visible at t.me/s/<name>, the app can read it.',
              style: AppType.body,
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: OutlinedButton.icon(
              icon: const Icon(Icons.save_outlined),
              label: const Text('Save channels'),
              onPressed: () async {
                await context.read<AppSettings>().setTelegramChannels(_channelsController.text.split(','));
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(content: Text('Following ${settings.telegramChannels.length} channel(s)')),
                  );
                }
              },
            ),
          ),
          const Divider(),
          const Padding(
            padding: EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Text('Cloud backend (optional)', style: AppType.label),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              controller: _cloudController,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(
                hintText: 'https://your-backend.onrender.com',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Text(
              settings.cloudConfigured
                  ? 'Set — posts are parsed, settled, and scored server-side; push is registered.'
                  : 'Empty — standalone mode: live posts and fixtures on-device; pick parsing, '
                      'tipster scores, and push need a backend (docs/RUNBOOK.md §1).',
              style: AppType.body,
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
            child: OutlinedButton.icon(
              icon: const Icon(Icons.cloud_sync_outlined),
              label: Text(settings.cloudConfigured ? 'Update URL' : 'Connect'),
              onPressed: () async {
                await context.read<AppSettings>().setCloudUrl(_cloudController.text);
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        context.read<AppSettings>().cloudConfigured
                            ? 'Cloud backend set'
                            : 'Cloud backend cleared',
                      ),
                    ),
                  );
                }
              },
            ),
          ),
          const Divider(),
          SwitchListTile(
            title: const Text('Reduce transparency'),
            subtitle: const Text('Replace blurred surfaces with solid ones'),
            value: settings.reduceTransparency,
            onChanged: (value) => context.read<AppSettings>().setReduceTransparency(value),
          ),
        ],
      ),
    );
  }
}
