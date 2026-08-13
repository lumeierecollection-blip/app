import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../services/settings.dart';
import '../theme/type.dart';

/// docs/DESIGN.md §11.8 screen 6 (sources, alias table, manual paste
/// input -- all deferred-social-path features, not built while
/// sources.social.enabled is off) plus the §11.3a/§11.4 "Reduce
/// transparency" setting, which is real and functional here: Flutter has
/// no OS-level signal for prefers-reduced-transparency, so every
/// BackdropFilter surface needs to read this in-app setting instead.
class AdminScreen extends StatelessWidget {
  const AdminScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final settings = context.watch<AppSettings>();
    return Scaffold(
      appBar: AppBar(title: const Text('Admin')),
      body: ListView(
        children: [
          SwitchListTile(
            title: const Text('Reduce transparency'),
            subtitle: const Text('Replace blurred surfaces with solid ones'),
            value: settings.reduceTransparency,
            onChanged: (value) => context.read<AppSettings>().setReduceTransparency(value),
          ),
          const Divider(),
          const Padding(
            padding: EdgeInsets.all(16),
            child: Text(
              'Sources, the team-name alias table, and manual tip paste are part of the '
              'deferred social-tipster path (sources.social.enabled, currently off) and are '
              'not built here yet.',
              style: AppType.body,
            ),
          ),
        ],
      ),
    );
  }
}
