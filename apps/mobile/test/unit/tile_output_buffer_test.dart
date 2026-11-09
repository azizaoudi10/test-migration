import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/tiles/tile_output_buffer.dart';

void main() {
  group('TileOutputBuffer', () {
    test('strips ANSI escape sequences', () {
      final buffer = TileOutputBuffer();
      buffer.append('\x1b[32mgreen\x1b[0m text');
      expect(buffer.lines.first, 'green text');
    });

    test('splits lines on newline', () {
      final buffer = TileOutputBuffer();
      buffer.append('line1\nline2');
      expect(buffer.lines, ['line1', 'line2']);
    });

    test('CRLF is a plain newline and does not erase the line', () {
      final buffer = TileOutputBuffer();
      buffer.append('line1\r\nline2');
      expect(buffer.lines, ['line1', 'line2']);
    });

    test('CRLF split across chunks stays a plain newline', () {
      final buffer = TileOutputBuffer();
      buffer.append('line1\r');
      buffer.append('\nline2');
      expect(buffer.lines, ['line1', 'line2']);
    });

    test('lone carriage return resets the current line', () {
      final buffer = TileOutputBuffer();
      buffer.append('old\rnew');
      expect(buffer.lines, ['new']);
    });

    test('trailing lone carriage return resolves against the next chunk', () {
      final buffer = TileOutputBuffer();
      buffer.append('old\r');
      expect(buffer.lines, ['old']);
      buffer.append('new');
      expect(buffer.lines, ['new']);
    });

    test('backspace removes a full Unicode rune (surrogate pair safe)', () {
      final buffer = TileOutputBuffer();
      buffer.append('a😀b\b');
      expect(buffer.lines, ['a😀']);
      buffer.append('\b');
      expect(buffer.lines, ['a']);
      buffer.append('\b');
      expect(buffer.lines, ['']);
    });

    test('starts empty so the no-output state is reachable', () {
      final buffer = TileOutputBuffer();
      expect(buffer.lines, isEmpty);
      expect(buffer.lineCount, 0);
      buffer.append('a');
      expect(buffer.lines, ['a']);
    });

    test('clear returns to the empty state', () {
      final buffer = TileOutputBuffer();
      buffer.append('a\nb');
      buffer.clear();
      expect(buffer.lines, isEmpty);
    });

    test('respects max lines', () {
      final buffer = TileOutputBuffer(maxLines: 5);
      for (var i = 0; i < 10; i++) {
        buffer.append('line$i\n');
      }
      expect(buffer.lineCount, 5);
      expect(buffer.lines[3], 'line9');
      expect(buffer.lines.last, '');
    });

    test('snapshot resets prior content', () {
      final buffer = TileOutputBuffer();
      buffer.append('stale\n');
      buffer.reset('fresh');
      expect(buffer.lines, ['fresh']);
    });

    test('lines view is cached until the buffer changes', () {
      final buffer = TileOutputBuffer();
      buffer.append('a');
      final first = buffer.lines;
      expect(identical(first, buffer.lines), isTrue);
      buffer.append('b');
      expect(identical(first, buffer.lines), isFalse);
      expect(buffer.lines, ['ab']);
    });
  });
}
