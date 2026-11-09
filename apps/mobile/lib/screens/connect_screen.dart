import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/protocol/models.dart';
import '../core/protocol/pairing_code.dart';
import '../state/app_controller.dart';

class ConnectScreen extends StatefulWidget {
  const ConnectScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends State<ConnectScreen>
    with SingleTickerProviderStateMixin {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _addressController;
  late final TextEditingController _codeController;
  final _deviceNameController = TextEditingController();
  bool _pairing = false;
  bool _discovering = false;
  bool _hasScanned = false;
  List<DiscoveredDevice> _discovered = [];
  late final AnimationController _entranceController;
  late final Animation<double> _entranceAnimation;

  @override
  void initState() {
    super.initState();
    _entranceController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 400),
    );
    _entranceAnimation = CurvedAnimation(
      parent: _entranceController,
      curve: Curves.easeInOut,
    );
    _entranceController.forward();
    final stored = widget.controller.stored;
    _addressController = TextEditingController(
      text: stored == null ? '' : '${stored.host}:${stored.port}',
    );
    _codeController = TextEditingController();
    widget.controller.addListener(_onControllerChanged);
  }

  @override
  void dispose() {
    _entranceController.dispose();
    widget.controller.removeListener(_onControllerChanged);
    _addressController.dispose();
    _codeController.dispose();
    _deviceNameController.dispose();
    super.dispose();
  }

  void _onControllerChanged() {
    final pairing = widget.controller.phase == AppPhase.pairing;
    if (pairing != _pairing) setState(() => _pairing = pairing);
  }

  Future<void> _connect() async {
    if (!_formKey.currentState!.validate()) return;
    final hostPort = HostPort.tryParse(_addressController.text)!;
    final deviceName =
        _deviceNameController.text.trim().isEmpty
            ? 'Fraktole Remote'
            : _deviceNameController.text.trim();
    await widget.controller.pair(
      host: hostPort.host,
      port: hostPort.port,
      code: _codeController.text,
      deviceName: deviceName,
    );
  }

  Future<void> _discover() async {
    setState(() {
      _discovering = true;
      _discovered = [];
    });
    try {
      final results = await widget.controller.discoverDevices();
      if (!mounted) return;
      setState(() {
        _discovered = results;
        _hasScanned = true;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _discovered = [];
        _hasScanned = true;
      });
    } finally {
      if (mounted) setState(() => _discovering = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: SlideTransition(
              position: Tween<Offset>(
                begin: const Offset(0, 0.3),
                end: Offset.zero,
              ).animate(_entranceAnimation),
              child: FadeTransition(
                opacity: _entranceAnimation,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 480),
                  child: Form(
                key: _formKey,
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Text(
                      'Fraktole Remote',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.headlineMedium
                          ?.copyWith(fontWeight: FontWeight.w700, letterSpacing: 0.3),
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Pair this phone with your desktop Fraktole instance.',
                      textAlign: TextAlign.center,
                      style: theme.textTheme.bodyMedium,
                    ),
                    const SizedBox(height: 28),
                    if (widget.controller.stored != null) ...[
                      _SavedDeviceCard(controller: widget.controller),
                      const SizedBox(height: 16),
                    ],
                    if (widget.controller.phase == AppPhase.authFailed ||
                        widget.controller.errorMessage != null) ...[
                      _ErrorBanner(message: widget.controller.errorMessage),
                      const SizedBox(height: 16),
                    ],
                    OutlinedButton.icon(
                      onPressed: _discovering ? null : _discover,
                      icon: _discovering
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.search),
                      label: Text(
                          _discovering ? 'Discovering…' : 'Discover on LAN'),
                    ),
                    if (_discovered.isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Card(
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            for (final device in _discovered)
                              ListTile(
                                dense: true,
                                title: Text('${device.host}:${device.port}'),
                                trailing:
                                    const Icon(Icons.arrow_forward),
                                onTap: () => setState(() =>
                                    _addressController.text =
                                        '${device.host}:${device.port}'),
                              ),
                          ],
                        ),
                      ),
                    ] else if (_hasScanned && !_discovering) ...[
                      const SizedBox(height: 8),
                      Text(
                        'No desktops found on LAN.',
                        textAlign: TextAlign.center,
                        style: theme.textTheme.bodySmall,
                      ),
                    ],
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: _addressController,
                      keyboardType: TextInputType.url,
                      textInputAction: TextInputAction.next,
                      decoration: const InputDecoration(
                        labelText: 'Desktop address',
                        hintText: '192.168.1.20:8833',
                        border: OutlineInputBorder(),
                      ),
                      validator: (value) {
                        final parsed = HostPort.tryParse(value ?? '');
                        if (parsed == null) {
                          return 'Enter host:port (e.g. 192.168.1.20:8833)';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: _codeController,
                      textCapitalization: TextCapitalization.characters,
                      textInputAction: TextInputAction.next,
                      inputFormatters: [_PairingCodeFormatter()],
                      decoration: const InputDecoration(
                        labelText: 'Pairing code',
                        hintText: 'ABCD-EFGH',
                        border: OutlineInputBorder(),
                      ),
                      validator: (value) {
                        if (!PairingCode.isValid(value ?? '')) {
                          return 'Format XXXX-XXXX, letters or digits';
                        }
                        return null;
                      },
                    ),
                    const SizedBox(height: 16),
                    TextFormField(
                      controller: _deviceNameController,
                      textInputAction: TextInputAction.done,
                      onFieldSubmitted: (_) => _connect(),
                      decoration: const InputDecoration(
                        labelText: 'Device name (optional)',
                        hintText: 'Pixel 8',
                        border: OutlineInputBorder(),
                      ),
                    ),
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _pairing ? null : _connect,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 14),
                        child: Text(_pairing ? 'Pairing…' : 'Connect'),
                      ),
                    ),
                  ],
                ),
              ),
              ),
            ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SavedDeviceCard extends StatelessWidget {
  const _SavedDeviceCard({required this.controller});

  final AppController controller;

  @override
  Widget build(BuildContext context) {
    final stored = controller.stored!;
    return Card(
      child: ListTile(
        title: Text('Paired with ${stored.host}:${stored.port}'),
        subtitle: Text(stored.deviceName),
        trailing: FilledButton.tonal(
          onPressed: controller.reconnect,
          child: const Text('Reconnect'),
        ),
      ),
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner({required this.message});

  final String? message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final text = message ?? 'Authentication failed.';
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: theme.colorScheme.errorContainer,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              text,
              style: TextStyle(color: theme.colorScheme.onErrorContainer),
            ),
          ),
        ],
      ),
    );
  }
}

class _PairingCodeFormatter extends TextInputFormatter {
  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final normalized = PairingCode.normalize(newValue.text);
    final selection = TextSelection.collapsed(offset: normalized.length);
    return TextEditingValue(text: normalized, selection: selection);
  }
}
