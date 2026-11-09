class TileOutputEvent {
  const TileOutputEvent({
    required this.tileId,
    required this.data,
    required this.ts,
    this.clientTileId,
  });

  /// Live ephemeral desktop tile id (the id as sent on the wire).
  final String tileId;
  final String? clientTileId;
  final String data;
  final int ts;
}

class TileSnapshotEvent {
  const TileSnapshotEvent({
    required this.tileId,
    required this.data,
    this.clientTileId,
  });

  final String tileId;
  final String? clientTileId;
  final String data;
}

class TileStateEvent {
  const TileStateEvent({
    required this.tileId,
    required this.alive,
    required this.lines,
    this.clientTileId,
  });

  final String tileId;
  final String? clientTileId;
  final bool alive;
  final int lines;
}

class SessionStateEvent {
  const SessionStateEvent({required this.sessionId, required this.alive});

  final String sessionId;
  final bool alive;
}

class MessageNewEvent {
  const MessageNewEvent({
    required this.kind,
    required this.from,
    required this.to,
    required this.body,
    required this.ts,
  });

  final String kind;
  final String from;
  final String to;
  final String body;
  final int ts;
}

class PingFrame {
  const PingFrame({required this.ts});

  final int ts;
}

class ServerEvent {
  static Object? fromJson(Map<String, Object?> json) {
    final type = json['type'];
    final params = json['params'];
    if (type is! String || params is! Map<String, Object?>) return null;
    switch (type) {
      case 'tile.output': {
        final tileId = _nonEmptyString(params['tileId']);
        if (tileId == null) return null;
        return TileOutputEvent(
          tileId: tileId,
          clientTileId: _nonEmptyString(params['clientTileId']),
          data: _coerceString(params['data']),
          ts: _asInt(params['ts'], 0),
        );
      }
      case 'tile.snapshot': {
        final tileId = _nonEmptyString(params['tileId']);
        if (tileId == null) return null;
        return TileSnapshotEvent(
          tileId: tileId,
          clientTileId: _nonEmptyString(params['clientTileId']),
          data: _coerceString(params['data']),
        );
      }
      case 'tile.state': {
        final tileId = _nonEmptyString(params['tileId']);
        if (tileId == null) return null;
        return TileStateEvent(
          tileId: tileId,
          clientTileId: _nonEmptyString(params['clientTileId']),
          alive: _asBool(params['alive'], false),
          lines: _asInt(params['lines'], 0),
        );
      }
      case 'session.state': {
        final sessionId = _nonEmptyString(params['sessionId']);
        if (sessionId == null) return null;
        return SessionStateEvent(
          sessionId: sessionId,
          alive: _asBool(params['alive'], false),
        );
      }
      case 'message.new':
        return MessageNewEvent(
          kind: _asString(params['kind'], ''),
          from: _asString(params['from'], ''),
          to: _asString(params['to'], ''),
          body: _coerceString(params['body']),
          ts: _asInt(params['ts'], 0),
        );
      case 'ping':
        return PingFrame(ts: _asInt(params['ts'], 0));
    }
    return null;
  }

  static String? _nonEmptyString(Object? value) {
    if (value is String && value.isNotEmpty) return value;
    return null;
  }

  static String _asString(Object? value, String fallback) =>
      value is String ? value : fallback;

  static int _asInt(Object? value, int fallback) {
    if (value is int) return value;
    if (value is num) return value.toInt();
    if (value is String) return int.tryParse(value) ?? fallback;
    return fallback;
  }

  static bool _asBool(Object? value, bool fallback) =>
      value is bool ? value : fallback;

  static String _coerceString(Object? value) {
    if (value == null) return '';
    if (value is String) return value;
    if (value is List<int>) return String.fromCharCodes(value);
    return value.toString();
  }
}
