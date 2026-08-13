import 'package:flutter/material.dart';

import '../services/api_client.dart';
import '../theme/color.dart';
import '../theme/type.dart';

/// docs/ARCHITECTURE.md's App shell section: "Health screen -- build
/// this properly, it's the one immediately useful." Full spec (last
/// successful fixtures/odds poll per competition, API quota consumed,
/// sharp-line staleness) needs backend endpoints that don't exist yet;
/// what's real and wired up today is a live reachability check against
/// the API's own /health endpoint -- clearly distinguished from "no
/// edges found right now" per the doc's own warning that those two
/// facts must never look the same.
class HealthScreen extends StatefulWidget {
  const HealthScreen({super.key, required this.apiClient});

  final ApiClient apiClient;

  @override
  State<HealthScreen> createState() => _HealthScreenState();
}

class _HealthScreenState extends State<HealthScreen> {
  bool? _reachable;
  bool _checking = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    setState(() {
      _checking = true;
      _error = null;
    });
    try {
      final ok = await widget.apiClient.checkHealth();
      setState(() => _reachable = ok);
    } catch (e) {
      setState(() {
        _reachable = false;
        _error = e.toString();
      });
    } finally {
      setState(() => _checking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final reachable = _reachable;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Health'),
        actions: [
          IconButton(onPressed: _checking ? null : _check, icon: const Icon(Icons.refresh)),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Card(
            child: ListTile(
              leading: Icon(
                reachable == true ? Icons.check_circle : Icons.error,
                color: reachable == true ? AppColor.won : AppColor.lost,
              ),
              title: const Text('Backend API'),
              subtitle: Text(
                _checking
                    ? 'Checking...'
                    : reachable == true
                        ? 'Reachable'
                        : 'Unreachable${_error != null ? ': $_error' : ''}',
              ),
            ),
          ),
          const SizedBox(height: 16),
          const Text(
            'Ingestion poll status, API quota consumed, and sharp-line staleness per '
            'competition aren\'t wired up yet -- those need dedicated backend endpoints '
            'this task hasn\'t built. This check only confirms the API is reachable.',
            style: AppType.body,
          ),
        ],
      ),
    );
  }
}
