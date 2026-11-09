import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import '../protocol/events.dart';
import '../protocol/frames.dart';
import '../protocol/models.dart';
import '../protocol/rpc.dart';
import 'remote_gateway.dart';
import 'remote_socket.dart';

/// Upper bound applied to the reconnect backoff.
const int maxReconnectBackoffSeconds = 30;

/// Exponential reconnect backoff (1s, 2s, 4s, ...) with +/-20% jitter, capped
/// at [maxReconnectBackoffSeconds]. [jitterUnit] is the raw random sample in
/// [0, 1); tests pass a fixed value for deterministic assertions.
Duration computeReconnectBackoff(int attempt, double jitterUnit) {
  final exponent = attempt < 0 ? 0 : (attempt > 5 ? 5 : attempt);
  final baseSeconds = 1 << exponent; // 1, 2, 4, 8, 16, 32
  final capped = baseSeconds > maxReconnectBackoffSeconds
      ? maxReconnectBackoffSeconds
      : baseSeconds;
  if (capped >= maxReconnectBackoffSeconds) {
    // Flat at the cap: jitter here could make a later attempt shorter than
    // the previous one, which is exactly the "decreasing then resetting"
    // behaviour the backoff must avoid.
    return const Duration(seconds: maxReconnectBackoffSeconds);
  }
  final unit =
      jitterUnit < 0 ? 0.0 : (jitterUnit > 0.999999 ? 0.999999 : jitterUnit);
  final factor = 1 + (unit * 0.4 - 0.2);
  final seconds =
      (capped * factor).round().clamp(1, maxReconnectBackoffSeconds).toInt();
  return Duration(seconds: seconds);
}

/// A pinned certificate that keeps failing the TLS handshake is a mismatch,
/// not a transient network error: surface it after two consecutive failures.
bool shouldSurfaceCertMismatch({
  required bool hasPin,
  required int consecutiveFailures,
}) =>
    hasPin && consecutiveFailures >= 2;

class RemoteClient implements RemoteGateway {
  RemoteClient({this._rpcTimeout = const Duration(seconds: 15)});

  final Duration _rpcTimeout;

  final StreamController<ConnectionStatus> _statusController =
      StreamController.broadcast();
  final StreamController<TileOutputEvent> _tileOutputs =
      StreamController.broadcast();
  final StreamController<TileSnapshotEvent> _tileSnapshots =
      StreamController.broadcast();
  final StreamController<TileStateEvent> _tileStates =
      StreamController.broadcast();
  final StreamController<SessionStateEvent> _sessionStates =
      StreamController.broadcast();
  final StreamController<MessageNewEvent> _messageNews =
      StreamController.broadcast();

  RemoteSocket? _socket;
  StreamSubscription<String>? _socketSub;
  Timer? _reconnectTimer;
  Timer? _authTimeout;

  ConnectionStatus _status = ConnectionStatus.disconnected;
  AuthInfo? _authInfo;
  String? _serverFingerprint;
  String? _lastError;

  String? _host;
  int? _port;
  String? _token;
  String? _pinnedFingerprint;
  bool _keepOpen = false;
  bool _authFailed = false;
  int _backoffAttempt = 0;
  int _consecutiveHandshakeFailures = 0;
  int _nextId = 1;
  final Random _random = Random();
  final Map<int, Completer<Object?>> _pending = {};

  /// Subscriptions keyed by a `sessionId/tileId` composite; agent ids repeat
  /// across sessions, so a bare tileId key would collide.
  final Map<String, ({String sessionId, String tileId})> _subscribedTiles = {};

  /// Reverse mapping: live tile id (as tagged in streamed events) -> the
  /// client-facing agent id the UI subscribed with.
  final Map<String, String> _liveToClientTile = {};

  @override
  ConnectionStatus get status => _status;

  @override
  AuthInfo? get authInfo => _authInfo;

  @override
  String? get serverFingerprint => _serverFingerprint;

  @override
  String? get lastError => _lastError;

  @override
  Stream<ConnectionStatus> get statusChanges => _statusController.stream;

  @override
  Stream<TileOutputEvent> get tileOutputs => _tileOutputs.stream;

  @override
  Stream<TileSnapshotEvent> get tileSnapshots => _tileSnapshots.stream;

  @override
  Stream<TileStateEvent> get tileStates => _tileStates.stream;

  @override
  Stream<SessionStateEvent> get sessionStates => _sessionStates.stream;

  @override
  Stream<MessageNewEvent> get messageNews => _messageNews.stream;

  void _setStatus(ConnectionStatus value) {
    _status = value;
    _statusController.add(value);
  }

  @override
  Future<PairResult> pair({
    required String host,
    required int port,
    required String code,
    required String deviceName,
  }) async {
    String? fingerprint;
    final socket = await RemoteSocket.open(
      Uri.parse('wss://$host:$port/'),
      acceptAnyCert: true,
      onPeerFingerprint: (fp) => fingerprint = fp,
    );
    try {
      socket.send(PairFrame(code: code, deviceName: deviceName).encode());
      late Map<String, Object?> pairResponse;
      try {
        pairResponse = await socket.messages
            .map(_decodeJson)
            .where((m) => m != null)
            .cast<Map<String, Object?>>()
            .first
            .timeout(const Duration(seconds: 10));
      } on TimeoutException {
        throw const RemoteException('Desktop did not respond to pairing');
      } on StateError {
        throw const RemoteException('Desktop closed the pairing connection');
      }
      final type = pairResponse['type'];
      if (type == 'pair-ok') {
        final ok = PairOk.fromJson(pairResponse);
        if (ok == null) {
          throw const RemoteException('Desktop sent a malformed pair response');
        }
        // Never trust a fingerprint the server merely claims: pairing pins the
        // certificate the TLS handshake actually presented.
        final captured = fingerprint;
        if (captured == null || captured.isEmpty) {
          throw const RemoteException(
              'Could not verify the desktop certificate fingerprint');
        }
        return PairResult(
          token: ok.token,
          deviceId: ok.deviceId,
          fingerprint: captured,
        );
      }
      if (type == 'pair-fail') {
        final fail = PairFail.fromJson(pairResponse);
        throw RemoteException(_pairFailMessage(fail.reason),
            code: RpcErrorCodes.notAuthenticated);
      }
      throw RemoteException('Unexpected response during pairing: $type');
    } finally {
      await socket.close();
    }
  }

  String _pairFailMessage(String reason) {
    switch (reason) {
      case 'invalid-code':
        return 'Pairing code is invalid';
      case 'expired':
        return 'Pairing code has expired';
      default:
        return 'Pairing failed: $reason';
    }
  }

  @override
  Future<void> connect({
    required String host,
    required int port,
    required String token,
    required String fingerprint,
  }) async {
    _host = host;
    _port = port;
    _token = token;
    _pinnedFingerprint = fingerprint;
    _keepOpen = true;
    _authFailed = false;
    _backoffAttempt = 0;
    await _connectOnce();
  }

  bool get _hasPinnedFingerprint =>
      _pinnedFingerprint != null && _pinnedFingerprint!.isNotEmpty;

  Future<void> _connectOnce() async {
    if (!_keepOpen) return;
    _setStatus(ConnectionStatus.connecting);
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _authTimeout?.cancel();
    _authTimeout = null;
    _socketSub?.cancel();
    _socketSub = null;
    _socket?.close();
    _socket = null;
    _serverFingerprint = _pinnedFingerprint;
    try {
      final socket = await RemoteSocket.open(
        Uri.parse('wss://$_host:$_port/'),
        acceptAnyCert: false,
        pinnedFingerprint: _pinnedFingerprint,
      );
      if (!_keepOpen) {
        await socket.close();
        return;
      }
      _socket = socket;
      // A completed TLS handshake means the pinned cert matched, so it breaks
      // any run of consecutive handshake failures.
      _consecutiveHandshakeFailures = 0;
      _socketSub = socket.messages.listen(
        _onMessage,
        onDone: _onSocketClosed,
        onError: (_) => _onSocketClosed(),
      );
      socket.send(AuthFrame(token: _token!).encode());
      _authTimeout = Timer(const Duration(seconds: 8), () {
        _onSocketClosed();
      });
    } catch (e) {
      _lastError = '$e';
      // SocketException (TCP-level failure) and HandshakeException (TLS-level
      // failure: transient network glitch mid-handshake, desktop restarting
      // its WSS server) are both retryable. A pinned certificate that fails
      // the handshake twice in a row is NOT transient: surface a distinct
      // certMismatch state so the user can re-pair instead of watching
      // "Connecting" forever.
      if (e is HandshakeException) {
        _consecutiveHandshakeFailures += 1;
        if (shouldSurfaceCertMismatch(
          hasPin: _hasPinnedFingerprint,
          consecutiveFailures: _consecutiveHandshakeFailures,
        )) {
          _lastError =
              'Desktop certificate does not match the paired fingerprint. Re-pair to continue.';
          _failAllPending(const RemoteException(
            'Certificate mismatch',
            code: RpcErrorCodes.connectionClosed,
          ));
          _setStatus(ConnectionStatus.certMismatch);
          return;
        }
        _onSocketClosed();
        return;
      }
      if (e is SocketException) {
        _onSocketClosed();
        return;
      }
      _failFatal();
    }
  }

  void _failFatal() {
    _keepOpen = false;
    _failAllPending(RemoteException(
      _lastError ?? 'Connection failed',
      code: RpcErrorCodes.connectionClosed,
    ));
    _setStatus(ConnectionStatus.disconnected);
  }

  void _onMessage(String raw) {
    final json = _decodeJson(raw);
    if (json is! Map<String, Object?>) return;
    if (json['type'] is String) {
      _onServerFrame(json);
      return;
    }
    if (json['id'] is int) {
      final response = RpcResponse.fromJson(json);
      if (response != null) _onRpcResponse(response);
    }
  }

  Map<String, Object?>? _decodeJson(String raw) {
    try {
      final decoded = jsonDecode(raw);
      return decoded is Map<String, Object?> ? decoded : null;
    } on FormatException {
      return null;
    }
  }

  void _onServerFrame(Map<String, Object?> json) {
    final type = json['type'];
    if (type is! String) return;
    if (type == 'auth-ok') {
      final ok = AuthOk.fromJson(json);
      if (ok == null) return;
      // Only auth-ok/auth-fail settle the pre-auth handshake; an arbitrary
      // pre-auth frame must not disarm the timeout while the token is
      // still unverified.
      _authTimeout?.cancel();
      _authTimeout = null;
      _consecutiveHandshakeFailures = 0;
      _authInfo = AuthInfo(
        serverName: ok.serverName,
        version: ok.version,
        deviceId: ok.deviceId,
      );
      _setStatus(ConnectionStatus.connected);
      _backoffAttempt = 0;
      _resubscribeTiles();
      return;
    }
    if (type == 'auth-fail') {
      final fail = AuthFail.fromJson(json);
      _authTimeout?.cancel();
      _authTimeout = null;
      _authFailed = true;
      _keepOpen = false;
      _setStatus(ConnectionStatus.authFailed);
      _failAllPending(RemoteException(
        fail.reason == 'bad-token'
            ? 'Token rejected by server'
            : 'Authentication failed: ${fail.reason}',
        code: RpcErrorCodes.notAuthenticated,
      ));
      _socket?.close();
      return;
    }
    if (type == 'pong') return;
    final event = ServerEvent.fromJson(json);
    if (event is TileOutputEvent) {
      final clientTileId = _resolveClientTile(event.tileId, event.clientTileId);
      if (clientTileId == null) return;
      _tileOutputs.add(TileOutputEvent(
        tileId: clientTileId,
        data: event.data,
        ts: event.ts,
      ));
    } else if (event is TileSnapshotEvent) {
      final clientTileId = _resolveClientTile(event.tileId, event.clientTileId);
      if (clientTileId == null) return;
      _tileSnapshots.add(TileSnapshotEvent(
        tileId: clientTileId,
        data: event.data,
      ));
    } else if (event is TileStateEvent) {
      final clientTileId = _resolveClientTile(event.tileId, event.clientTileId);
      if (clientTileId == null) return;
      _tileStates.add(TileStateEvent(
        tileId: clientTileId,
        alive: event.alive,
        lines: event.lines,
      ));
    } else if (event is SessionStateEvent) {
      _sessionStates.add(event);
    } else if (event is MessageNewEvent) {
      _messageNews.add(event);
    } else if (event is PingFrame) {
      _socket?.send(PongFrame(params: {'ts': event.ts}).encode());
    }
  }

  /// Resolves the UI-facing tile id for a streamed frame. The desktop tags
  /// frames with the live recorder id plus the `clientTileId` the phone
  /// subscribed with; frames without either are dropped instead of leaking
  /// an unmatched id to the UI.
  String? _resolveClientTile(String liveTileId, String? clientTileId) {
    final tagged = clientTileId;
    final mapped = _liveToClientTile[liveTileId];
    final client = (tagged != null && tagged.isNotEmpty)
        ? tagged
        : (mapped != null && mapped.isNotEmpty ? mapped : null);
    if (client == null || !_isSubscribedClientTile(client)) return null;
    if (liveTileId.isNotEmpty && _liveToClientTile[liveTileId] != client) {
      _liveToClientTile[liveTileId] = client;
    }
    return client;
  }

  bool _isSubscribedClientTile(String clientTileId) {
    for (final sub in _subscribedTiles.values) {
      if (sub.tileId == clientTileId) return true;
    }
    return false;
  }

  void _onRpcResponse(RpcResponse response) {
    final completer = _pending.remove(response.id);
    if (completer == null) return;
    if (response.isError) {
      completer.completeError(RemoteException(
        response.error!.message,
        code: response.error!.code,
      ));
    } else {
      completer.complete(response.result);
    }
  }

  void _failAllPending(Object error) {
    for (final completer in _pending.values) {
      completer.completeError(error);
    }
    _pending.clear();
  }

  void _onSocketClosed() {
    _authTimeout?.cancel();
    _authTimeout = null;
    _socketSub?.cancel();
    _socketSub = null;
    final socket = _socket;
    _socket = null;
    socket?.close();
    _failAllPending(const RemoteException(
      'Connection closed',
      code: RpcErrorCodes.connectionClosed,
    ));
    if (!_keepOpen) {
      _setStatus(ConnectionStatus.disconnected);
      return;
    }
    if (_authFailed) return;
    _reconnectTimer?.cancel();
    final delay =
        computeReconnectBackoff(_backoffAttempt++, _random.nextDouble());
    _setStatus(ConnectionStatus.connecting);
    _reconnectTimer = Timer(delay, _connectOnce);
  }

  String _tileKey(String sessionId, String tileId) => '$sessionId/$tileId';

  void _resubscribeTiles() {
    for (final sub in _subscribedTiles.values) {
      unawaited(_resubscribeTile(sub.sessionId, sub.tileId));
    }
  }

  Future<void> _resubscribeTile(String sessionId, String tileId) async {
    try {
      final result = await rpc(
        'tile.subscribe',
        {'sessionId': sessionId, 'tileId': tileId},
      );
      _recordLiveTile(result, tileId);
    } catch (_) {
      // The reconnect/backoff path retries; a failed resubscribe only means
      // the tile is not live on this connection yet.
    }
  }

  void _recordLiveTile(Object? result, String clientTileId) {
    if (result is Map<String, Object?>) {
      final live = result['liveTileId'];
      if (live is String && live.isNotEmpty) {
        _liveToClientTile[live] = clientTileId;
      }
    }
  }

  @override
  Future<Object?> rpc(String method, [Map<String, Object?> params = const {}]) {
    if (_status != ConnectionStatus.connected) {
      return Future.error(const RemoteException(
        'Not connected',
        code: RpcErrorCodes.notAuthenticated,
      ));
    }
    final id = _nextId++;
    final completer = Completer<Object?>();
    _pending[id] = completer;
    _socket?.send(RpcRequest(id: id, method: method, params: params).encode());
    final timer = Timer(_rpcTimeout, () {
      if (_pending.remove(id) != null) {
        completer.completeError(const RemoteException(
          'Request timed out',
          code: RpcErrorCodes.timeout,
        ));
      }
    });
    return completer.future.whenComplete(timer.cancel);
  }

  @override
  Future<void> subscribeTile({
    required String sessionId,
    required String tileId,
  }) async {
    _subscribedTiles[_tileKey(sessionId, tileId)] =
        (sessionId: sessionId, tileId: tileId);
    final result = await rpc(
        'tile.subscribe', {'sessionId': sessionId, 'tileId': tileId});
    _recordLiveTile(result, tileId);
  }

  @override
  Future<void> unsubscribeTile({
    required String sessionId,
    required String tileId,
  }) async {
    _subscribedTiles.remove(_tileKey(sessionId, tileId));
    _liveToClientTile.removeWhere((_, v) => v == tileId);
    try {
      await rpc('tile.unsubscribe', {'sessionId': sessionId, 'tileId': tileId});
    } catch (_) {}
  }

  /// Broadcasts `FRAKTOLE-DISCOVER` on the LAN and collects `FRAKTOLE-HERE
  /// <port>` replies until [timeout]. Best-effort: any error yields whatever
  /// was found so far, never a throw.
  @override
  Future<List<DiscoveredDevice>> discoverDevices(
      {Duration timeout = const Duration(seconds: 2)}) async {
    final found = <String, DiscoveredDevice>{};
    RawDatagramSocket? socket;
    try {
      socket = await RawDatagramSocket.bind(InternetAddress.anyIPv4, 0);
    } catch (_) {
      return [];
    }
    final udp = socket;
    try {
      udp.broadcastEnabled = true;
      final targets = <int>{8833};
      final stored = _port;
      if (stored != null && stored >= 1 && stored <= 65535) {
        targets.add(stored);
      }
      final probe = utf8.encode('FRAKTOLE-DISCOVER');
      final broadcast = InternetAddress('255.255.255.255');
      for (final target in targets) {
        try {
          udp.send(probe, broadcast, target);
        } catch (_) {}
      }
      const prefix = 'FRAKTOLE-HERE ';
      final deadline = DateTime.now().add(timeout);
      await for (final event
          in udp.timeout(timeout, onTimeout: (sink) => sink.close())) {
        if (event == RawSocketEvent.read) {
          Datagram? datagram;
          while ((datagram = udp.receive()) != null) {
            try {
              final dg = datagram!;
              final text = utf8.decode(dg.data);
              if (!text.startsWith(prefix)) continue;
              final port =
                  int.tryParse(text.substring(prefix.length).trim());
              if (port == null || port < 1 || port > 65535) continue;
              final host = dg.address.address;
              found['$host:$port'] =
                  DiscoveredDevice(host: host, port: port);
            } catch (_) {}
          }
        }
        if (!DateTime.now().isBefore(deadline)) break;
      }
    } catch (_) {
      // best-effort: return whatever was found
    } finally {
      try {
        udp.close();
      } catch (_) {}
    }
    return found.values.toList();
  }

  @override
  Future<void> disconnect() async {
    _keepOpen = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _authTimeout?.cancel();
    _authTimeout = null;
    _failAllPending(const RemoteException(
      'Disconnected',
      code: RpcErrorCodes.connectionClosed,
    ));
    await _socket?.close();
    _socket = null;
    _socketSub?.cancel();
    _socketSub = null;
    _subscribedTiles.clear();
    _liveToClientTile.clear();
    _setStatus(ConnectionStatus.disconnected);
  }

  @override
  void dispose() {
    _keepOpen = false;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _authTimeout?.cancel();
    _authTimeout = null;
    _failAllPending(const RemoteException(
      'Disposed',
      code: RpcErrorCodes.connectionClosed,
    ));
    _socketSub?.cancel();
    _socketSub = null;
    _socket?.close();
    _socket = null;
    _subscribedTiles.clear();
    _liveToClientTile.clear();
    _statusController.close();
    _tileOutputs.close();
    _tileSnapshots.close();
    _tileStates.close();
    _sessionStates.close();
    _messageNews.close();
  }
}
