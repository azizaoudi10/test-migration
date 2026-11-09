import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/app_controller.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onControllerChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onControllerChanged);
    super.dispose();
  }

  void _onControllerChanged() {
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final stored = widget.controller.stored;
    final authInfo = widget.controller.authInfo;
    final phase = widget.controller.phase;
    final error = widget.controller.errorMessage;

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: SafeArea(
        child: _buildBody(phase, error, stored, authInfo, theme),
      ),
    );
  }

  Widget _buildBody(
    AppPhase phase,
    String? error,
    StoredConnection? stored,
    AuthInfo? authInfo,
    ThemeData theme,
  ) {
    if (phase == AppPhase.connecting) {
      return const Center(child: CircularProgressIndicator());
    }
    if (error != null) {
      return Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text('Error: $error'),
            TextButton(onPressed: () => setState(() {}), child: const Text('Retry')),
          ],
        ),
      );
    }
    if (stored == null) {
      return const Center(child: Text('No connection data yet'));
    }
    return _settingsList(stored, authInfo, theme);
  }

  Widget _settingsList(StoredConnection stored, AuthInfo? authInfo, ThemeData theme) {
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 300),
      child: ListView(
        key: ValueKey(stored.deviceId),
        padding: const EdgeInsets.all(12),
        children: [
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeInOut,
            child: Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Device',
                        style: theme.textTheme.titleMedium
                            ?.copyWith(fontWeight: FontWeight.w600)),
                    const SizedBox(height: 12),
                    _InfoRow(
                      label: 'Desktop',
                      value: '${stored.host}:${stored.port}',
                    ),
                    _InfoRow(label: 'Device name', value: stored.deviceName ?? '—'),
                    _InfoRow(label: 'Device ID', value: stored.deviceId ?? '—'),
                    _InfoRow(label: 'Server', value: authInfo?.serverName ?? '—'),
                    _InfoRow(label: 'Version', value: authInfo?.version ?? '—'),
                    const SizedBox(height: 8),
                    Text('Server certificate fingerprint',
                        style: theme.textTheme.bodySmall),
                    const SizedBox(height: 4),
                    SelectableText(
                      _groupedFingerprint(stored.fingerprint ?? ''),
                      style: const TextStyle(fontFamily: 'monospace', fontSize: 11),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Verify it matches the fingerprint shown on your desktop.',
                      style: theme.textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeInOut,
            child: Card(
              child: Column(
                children: [
                  ListTile(
                    title: const Text('Export prompts'),
                    subtitle: const Text('Show the prompt library as JSON'),
                    onTap: () => _exportPrompts(context),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    title: const Text('Import prompts'),
                    subtitle: const Text('Paste exported JSON to restore prompts'),
                    onTap: () => _importPrompts(context),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          AnimatedContainer(
            duration: const Duration(milliseconds: 200),
            curve: Curves.easeInOut,
            child: Card(
              child: Column(
                children: [
                  ListTile(
                    title: const Text('Disconnect'),
                    subtitle: const Text('Reconnect later with saved credentials'),
                    onTap: () => widget.controller.disconnect(),
                  ),
                  const Divider(height: 1),
                  ListTile(
                    title: Text('Forget this device',
                        style: TextStyle(color: theme.colorScheme.error)),
                    subtitle: const Text('Erase token and fingerprint, go back to pairing'),
                    onTap: () async {
                      final confirmed = await showDialog<bool>(
                        context: context,
                        builder: (ctx) => AlertDialog(
                          title: const Text('Forget this device?'),
                          content: const Text(
                              'This erases the saved token and certificate fingerprint for this desktop. You will need to pair again.'),
                          actions: [
                            TextButton(
                                onPressed: () => Navigator.of(ctx).pop(false),
                                child: const Text('Cancel')),
                            TextButton(
                                onPressed: () => Navigator.of(ctx).pop(true),
                                child: const Text('Forget')),
                          ],
                        ),
                      );
                      if (!context.mounted) return;
                      if (confirmed == true) await widget.controller.forget();
                    },
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 24),
          Center(
            child: Text('Fraktole Remote v1.0',
                style: TextStyle(color: theme.disabledColor, fontSize: 11)),
          ),
        ],
      ),
    );
  }

  String _groupedFingerprint(String fingerprint) {
    if (fingerprint.length != 64) return fingerprint;
    return RegExp(r'.{1,4}')
        .allMatches(fingerprint)
        .map((m) => m.group(0))
        .join(' ');
  }

  Future<void> _exportPrompts(BuildContext context) async {
    try {
      final json = await widget.controller.exportPrompts();
      if (!context.mounted) return;
      await showDialog<void>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Exported prompts'),
          content: SizedBox(
            width: double.maxFinite,
            child: SingleChildScrollView(child: SelectableText(json)),
          ),
          actions: [
            TextButton(
              onPressed: () async {
                await Clipboard.setData(ClipboardData(text: json));
                if (dialogContext.mounted) Navigator.of(dialogContext).pop();
                if (context.mounted) {
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('prompts copied to clipboard')),
                  );
                }
              },
              child: const Text('Copy'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Close'),
            ),
          ],
        ),
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('export failed: $e')),
      );
    }
  }

  Future<void> _importPrompts(BuildContext context) async {
    final textController = TextEditingController();
    try {
      final json = await showDialog<String>(
        context: context,
        builder: (dialogContext) => AlertDialog(
          title: const Text('Import prompts'),
          content: TextField(
            controller: textController,
            maxLines: 8,
            decoration: const InputDecoration(
              hintText: 'Paste exported prompts JSON here',
              border: OutlineInputBorder(),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(textController.text),
              child: const Text('Import'),
            ),
          ],
        ),
      );
      if (json == null || json.trim().isEmpty) return;
      final result = await widget.controller.importPrompts(json);
      if (!context.mounted) return;
      final imported = result['imported'];
      final errors = result['errors'];
      final errorCount = errors is List ? errors.length : 0;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text('imported $imported prompt(s)'
              '${errorCount > 0 ? ' — $errorCount error(s)' : ''}'),
        ),
      );
    } catch (e) {
      if (!context.mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('import failed: $e')),
      );
    } finally {
      textController.dispose();
    }
  }
}

class _InfoRow extends StatelessWidget {
  const _InfoRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 3),
      child: Row(
        children: [
          SizedBox(
            width: 110,
            child: Text(label,
                style: TextStyle(color: Theme.of(context).disabledColor)),
          ),
          Expanded(
            child: Text(value, style: const TextStyle(fontFamily: 'monospace')),
          ),
        ],
      ),
    );
  }
}
