import 'dart:async';

import 'package:flutter/material.dart';

import '../core/protocol/events.dart';
import '../core/protocol/models.dart';
import '../state/app_controller.dart';

class OrchestratorScreen extends StatefulWidget {
  const OrchestratorScreen({super.key, required this.controller});

  final AppController controller;

  @override
  State<OrchestratorScreen> createState() => _OrchestratorScreenState();
}

class _OrchestratorScreenState extends State<OrchestratorScreen> {
  final _taskFormKey = GlobalKey<FormState>();
  final _sessionIdController = TextEditingController();
  final _agentIdController = TextEditingController();
  final _taskBodyController = TextEditingController();
  String _taskKind = 'task';

  final _spawnFormKey = GlobalKey<FormState>();
  final _cwdController = TextEditingController();
  final _spawnKindController = TextEditingController();
  final _spawnNameController = TextEditingController();

  StreamSubscription<MessageNewEvent>? _messageSub;
  List<MailMessage>? _messages;
  Object? _messagesError;
  bool _sending = false;
  bool _spawning = false;
  bool _loadingMessages = true;
  String? _lastCurrentSessionId;

  @override
  void initState() {
    super.initState();
    _lastCurrentSessionId = widget.controller.currentSessionId;
    _sessionIdController.text = _lastCurrentSessionId ?? '';
    widget.controller.addListener(_onControllerChanged);
    _messageSub = widget.controller.messageNews.listen(_onMessageNew);
    _reloadMessages();
  }

  @override
  void dispose() {
    _messageSub?.cancel();
    widget.controller.removeListener(_onControllerChanged);
    _sessionIdController.dispose();
    _agentIdController.dispose();
    _taskBodyController.dispose();
    _cwdController.dispose();
    _spawnKindController.dispose();
    _spawnNameController.dispose();
    super.dispose();
  }

  void _onControllerChanged() {
    final current = widget.controller.currentSessionId;
    // Only react when the current session actually changes; other controller
    // notifications (unread badges) must not clobber a hand-typed session id.
    if (current == null ||
        current.isEmpty ||
        current == _lastCurrentSessionId) {
      return;
    }
    _lastCurrentSessionId = current;
    if (_sessionIdController.text == current) return;
    _sessionIdController.text = current;
  }

  void _onMessageNew(MessageNewEvent event) {
    if (!mounted) return;
    setState(() {
      final updated = [
        ...?_messages,
        MailMessage(
          kind: event.kind,
          from: event.from,
          to: event.to,
          body: event.body,
          ts: event.ts,
        ),
      ];
      _messages =
          updated.length > 50 ? updated.sublist(updated.length - 50) : updated;
      _messagesError = null;
      _loadingMessages = false;
    });
  }

  Future<void> _reloadMessages() async {
    if (!mounted) return;
    setState(() => _loadingMessages = true);
    try {
      final messages = await widget.controller.listMessages(limit: 50);
      if (!mounted) return;
      setState(() {
        _messages = messages;
        _messagesError = null;
        _loadingMessages = false;
      });
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _messagesError = e;
        _loadingMessages = false;
      });
    }
  }

  Future<void> _pickPrompt() async {
    List<PromptEntry> prompts;
    try {
      prompts = await widget.controller.listPrompts();
    } on Object {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('prompt library unavailable')),
      );
      return;
    }
    if (!mounted) return;
    final picked = await showModalBottomSheet<PromptEntry>(
      context: context,
      builder: (context) => ListView(
        shrinkWrap: true,
        children: [
          for (final prompt in prompts)
            ListTile(
              title: Text(prompt.name),
              subtitle: Text(
                prompt.tags.isEmpty
                    ? 'used ${prompt.useCount}x'
                    : '${prompt.tags.join(' · ')} · used ${prompt.useCount}x',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
              onTap: () => Navigator.of(context).pop(prompt),
            ),
        ],
      ),
    );
    if (picked == null) return;
    final current = _taskBodyController.text.trim();
    _taskBodyController.text =
        current.isEmpty ? picked.body : '$current\n${picked.body}';
  }

  Future<void> _sendTask() async {
    if (!_taskFormKey.currentState!.validate()) return;
    final sessionId = _sessionIdController.text.trim();
    if (sessionId.isEmpty) {
      _showMessage('Enter a session ID', isError: true);
      return;
    }
    setState(() => _sending = true);
    try {
      final result = await widget.controller.sendTask(
        sessionId: sessionId,
        agentId: _agentIdController.text.trim(),
        kind: _taskKind,
        body: _taskBodyController.text,
      );
      if (!mounted) return;
      _taskBodyController.clear();
      _showMessage('Task sent (${result.messageId})');
    } catch (e) {
      if (!mounted) return;
      _showMessage('Failed: $e', isError: true);
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  Future<void> _spawnAgent() async {
    if (!_spawnFormKey.currentState!.validate()) return;
    final sessionId = _sessionIdController.text.trim();
    setState(() => _spawning = true);
    try {
      final result = await widget.controller.spawnAgent(
        sessionId: sessionId.isEmpty ? null : sessionId,
        cwd: _cwdController.text.trim(),
        kind: _spawnKindController.text.trim(),
        name: _spawnNameController.text.trim(),
      );
      if (!mounted) return;
      _spawnNameController.clear();
      _showMessage('Agent spawned (${result.agentId})');
    } catch (e) {
      if (!mounted) return;
      _showMessage('Failed: $e', isError: true);
    } finally {
      if (mounted) setState(() => _spawning = false);
    }
  }

  void _showMessage(String text, {bool isError = false}) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(text),
        backgroundColor:
            isError ? Theme.of(context).colorScheme.error : null,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Orchestrator')),
      body: RefreshIndicator(
        onRefresh: _reloadMessages,
        child: SafeArea(
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: const EdgeInsets.all(12),
            children: [
              _SectionCard(
                title: 'Target session',
                child: TextFormField(
                  controller: _sessionIdController,
                  textInputAction: TextInputAction.next,
                  decoration: const InputDecoration(
                    labelText: 'Session ID',
                    helperText:
                        'Agent IDs repeat across sessions — pick the session first.',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                ),
              ),
              _SectionCard(
                title: 'Send a task',
                child: Form(
                  key: _taskFormKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextFormField(
                        controller: _agentIdController,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Agent ID',
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                        validator: (value) =>
                            (value ?? '').trim().isEmpty ? 'Enter agent ID' : null,
                      ),
                      const SizedBox(height: 12),
                      DropdownButtonFormField<String>(
                        initialValue: _taskKind,
                        decoration: const InputDecoration(
                          labelText: 'Kind',
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                        items: const [
                          DropdownMenuItem(value: 'task', child: Text('task')),
                          DropdownMenuItem(value: 'note', child: Text('note')),
                        ],
                        onChanged: (value) =>
                            setState(() => _taskKind = value ?? 'task'),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _taskBodyController,
                        maxLines: 4,
                        decoration: const InputDecoration(
                          labelText: 'Body',
                          border: OutlineInputBorder(),
                          alignLabelWithHint: true,
                        ),
                        validator: (value) =>
                            (value ?? '').trim().isEmpty ? 'Enter a body' : null,
                      ),
                      const SizedBox(height: 12),
                      OutlinedButton(
                        onPressed: _sending ? null : _pickPrompt,
                        child: const Text('Insert a saved prompt'),
                      ),
                      const SizedBox(height: 12),
                      FilledButton(
                        onPressed: _sending ? null : _sendTask,
                        child: Text(_sending ? 'Sending…' : 'Send'),
                      ),
                    ],
                  ),
                ),
              ),
              _SectionCard(
                title: 'Spawn agent',
                child: Form(
                  key: _spawnFormKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextFormField(
                        controller: _cwdController,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Working directory (optional)',
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _spawnKindController,
                        textInputAction: TextInputAction.next,
                        decoration: const InputDecoration(
                          labelText: 'Kind (optional)',
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 12),
                      TextFormField(
                        controller: _spawnNameController,
                        textInputAction: TextInputAction.done,
                        decoration: const InputDecoration(
                          labelText: 'Name (optional)',
                          border: OutlineInputBorder(),
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 12),
                      FilledButton.tonal(
                        onPressed: _spawning ? null : _spawnAgent,
                        child: Text(_spawning ? 'Spawning…' : 'Spawn'),
                      ),
                    ],
                  ),
                ),
              ),
              _SectionCard(
                title: 'Recent messages',
                child: _buildMessages(),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildMessages() {
    if (_loadingMessages && _messages == null) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    final error = _messagesError;
    if (error != null && _messages == null) {
      return Column(
        children: [
          Text('$error'),
          TextButton(onPressed: _reloadMessages, child: const Text('Retry')),
        ],
      );
    }
    final messages = _messages ?? const <MailMessage>[];
    if (messages.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(16),
        child: Center(child: Text('No messages yet')),
      );
    }
    return AnimatedSwitcher(
      duration: const Duration(milliseconds: 300),
      child: Column(
        key: ValueKey(messages.length),
        children: [
          for (final message in messages)
            _MessageTile(message: message),
        ],
      ),
    );
  }
}

class _SectionCard extends StatelessWidget {
  const _SectionCard({required this.title, required this.child});

  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Card(
      margin: const EdgeInsets.only(bottom: 12),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title,
                style: Theme.of(context)
                    .textTheme
                    .titleMedium
                    ?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 12),
            child,
          ],
        ),
      ),
    );
  }
}

class _MessageTile extends StatelessWidget {
  const _MessageTile({required this.message});

  final MailMessage message;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final time = message.timestamp.toLocal();
    final timeLabel =
        '${time.hour.toString().padLeft(2, '0')}:${time.minute.toString().padLeft(2, '0')}';
    return AnimatedContainer(
      duration: const Duration(milliseconds: 300),
      curve: Curves.easeInOut,
      padding: const EdgeInsets.only(bottom: 10),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Text(
                '[${message.kind}]',
                style: TextStyle(
                  fontFamily: 'monospace',
                  fontSize: 11,
                  color: theme.colorScheme.primary,
                ),
              ),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${message.from} → ${message.to}',
                  style: const TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11,
                  ),
                ),
              ),
              Text(timeLabel,
                  style: TextStyle(fontSize: 11, color: theme.disabledColor)),
            ],
          ),
          Text(
            message.body,
            style: const TextStyle(fontSize: 13, height: 1.3),
          ),
          const Divider(height: 16),
        ],
      ),
    );
  }
}
