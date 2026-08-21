import 'package:flutter/material.dart';

import 'services/api_client.dart';
import 'services/feed.dart';
import 'screens/admin_screen.dart';
import 'screens/audit_screen.dart';
import 'screens/health_screen.dart';
import 'screens/slips_screen.dart';
import 'screens/tipsters_screen.dart';

/// Plain `Navigator`/`IndexedStack` tab shell, matching tradeapp's
/// `app_shell.dart` (docs/ARCHITECTURE.md "App shell") -- no router
/// package at this scale. Tab labels match docs/DESIGN.md §11.8: Slips,
/// Tipsters, Audit, plus Health and Admin.
class AppShell extends StatefulWidget {
  const AppShell({super.key, required this.apiClient, this.feedLoader});

  final ApiClient apiClient;

  /// Injectable for tests; null uses the real loader.
  final FeedLoader? feedLoader;

  @override
  State<AppShell> createState() => _AppShellState();
}

class _AppShellState extends State<AppShell> {
  int _index = 0;

  @override
  Widget build(BuildContext context) {
    final screens = [
      SlipsScreen(apiClient: widget.apiClient, loader: widget.feedLoader),
      TipstersScreen(apiClient: widget.apiClient),
      const AuditScreen(),
      HealthScreen(apiClient: widget.apiClient),
      const AdminScreen(),
    ];

    return Scaffold(
      body: IndexedStack(index: _index, children: screens),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.receipt_long), label: 'Slips'),
          NavigationDestination(icon: Icon(Icons.leaderboard), label: 'Tipsters'),
          NavigationDestination(icon: Icon(Icons.fact_check), label: 'Audit'),
          NavigationDestination(icon: Icon(Icons.monitor_heart), label: 'Health'),
          NavigationDestination(icon: Icon(Icons.settings), label: 'Admin'),
        ],
      ),
    );
  }
}
