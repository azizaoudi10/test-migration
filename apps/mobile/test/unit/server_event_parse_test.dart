import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/protocol/events.dart';

void main() {
  group('ServerEvent.fromJson tolerates malformed frames', () {
    test('rejects tile events without a usable tileId', () {
      expect(
        ServerEvent.fromJson({
          'type': 'tile.output',
          'params': {'tileId': 5, 'data': 'x'},
        }),
        isNull,
      );
      expect(
        ServerEvent.fromJson({'type': 'tile.output', 'params': {}}),
        isNull,
      );
      expect(
        ServerEvent.fromJson({'type': 'tile.state', 'params': <String, Object?>{}}),
        isNull,
      );
    });

    test('parses both the live tile id and clientTileId', () {
      final event = ServerEvent.fromJson({
        'type': 'tile.output',
        'params': {
          'tileId': 'live-1',
          'clientTileId': 'agent-1',
          'data': 'hi',
          'ts': 3,
        },
      }) as TileOutputEvent;
      expect(event.tileId, 'live-1');
      expect(event.clientTileId, 'agent-1');
      expect(event.data, 'hi');
      expect(event.ts, 3);
    });

    test('coerces mistyped scalar fields instead of throwing', () {
      final state = ServerEvent.fromJson({
        'type': 'tile.state',
        'params': {'tileId': 't1', 'alive': 'yes', 'lines': '12'},
      }) as TileStateEvent;
      expect(state.alive, isFalse);
      expect(state.lines, 12);
    });

    test('ignores non-string message fields', () {
      final message = ServerEvent.fromJson({
        'type': 'message.new',
        'params': {
          'kind': 7,
          'from': null,
          'to': [],
          'body': 'b',
          'ts': '9',
        },
      }) as MessageNewEvent;
      expect(message.kind, '');
      expect(message.from, '');
      expect(message.to, '');
      expect(message.body, 'b');
      expect(message.ts, 9);
    });

    test('rejects session.state without a sessionId', () {
      expect(
        ServerEvent.fromJson({
          'type': 'session.state',
          'params': {'alive': true},
        }),
        isNull,
      );
    });
  });
}
