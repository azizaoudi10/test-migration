class TileOutputBuffer {
  TileOutputBuffer({this.maxLines = 2000});

  static final RegExp _ansiPattern = RegExp(
    r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Z]?',
  );

  final int maxLines;

  final List<String> _lines = [];

  /// Cached unmodifiable view of [_lines]; invalidated on every mutation so
  /// the [lines] getter stays allocation-free across rebuilds.
  List<String>? _linesView;

  /// A carriage return at the very end of a chunk: resolved against the next
  /// chunk so `...\r` followed by `\n` stays a plain newline instead of
  /// clearing the current line.
  bool _pendingCR = false;

  int get lineCount => _lines.length;

  List<String> get lines => _linesView ??= List.unmodifiable(_lines);

  static String stripAnsi(String data) => data.replaceAll(_ansiPattern, '');

  void append(String data) {
    final cleaned = stripAnsi(data);
    final runes = cleaned.runes.toList();
    var changed = false;
    for (var i = 0; i < runes.length; i++) {
      final rune = runes[i];
      if (_pendingCR) {
        _pendingCR = false;
        changed = true;
        if (rune == 0x0A) {
          _newLine();
          continue;
        }
        _clearCurrentLine();
        // fall through: the rune still needs to be processed
      }
      if (rune == 0x0A) {
        _newLine();
        changed = true;
      } else if (rune == 0x0D) {
        if (i + 1 >= runes.length) {
          _pendingCR = true;
        } else if (runes[i + 1] == 0x0A) {
          _newLine();
          i++; // consume the paired LF
          changed = true;
        } else {
          _clearCurrentLine();
          changed = true;
        }
      } else if (rune == 0x08) {
        _backspace();
        changed = true;
      } else if (rune < 32 && rune != 0x09) {
        continue;
      } else {
        _appendRune(rune);
        changed = true;
      }
    }
    if (changed) {
      _trim();
      _linesView = null;
    }
  }

  void reset(String data) {
    _lines.clear();
    _pendingCR = false;
    _linesView = null;
    append(data);
  }

  void clear() {
    _lines.clear();
    _pendingCR = false;
    _linesView = null;
  }

  void _newLine() {
    if (_lines.isEmpty) _lines.add('');
    _lines.add('');
  }

  void _clearCurrentLine() {
    if (_lines.isEmpty) return;
    _lines[_lines.length - 1] = '';
  }

  void _appendRune(int rune) {
    if (_lines.isEmpty) _lines.add('');
    _lines[_lines.length - 1] += String.fromCharCode(rune);
  }

  void _backspace() {
    if (_lines.isEmpty) return;
    final current = _lines[_lines.length - 1];
    if (current.isEmpty) return;
    final runes = current.runes.toList()..removeLast();
    _lines[_lines.length - 1] = String.fromCharCodes(runes);
  }

  void _trim() {
    if (_lines.length <= maxLines) return;
    final overflow = _lines.length - maxLines;
    _lines.removeRange(0, overflow);
  }
}
