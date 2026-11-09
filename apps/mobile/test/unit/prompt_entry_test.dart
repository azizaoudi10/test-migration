import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/protocol/models.dart';

void main() {
  test('parses a prompt row and tolerates malformed scalars', () {
    final entry = PromptEntry.fromJson(const {
      'id': 'pr-1',
      'name': 'Refactor',
      'body': 'do {{cwd}}',
      'tags': ['code', 42, 'tips'],
      'useCount': 3,
    });
    expect(entry.id, 'pr-1');
    expect(entry.name, 'Refactor');
    expect(entry.body, 'do {{cwd}}');
    expect(entry.tags, ['code', 'tips']);
    expect(entry.useCount, 3);

    final fallback = PromptEntry.fromJson(const {});
    expect(fallback.name, 'untitled');
    expect(fallback.body, '');
    expect(fallback.tags, isEmpty);
  });
}
