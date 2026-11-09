import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/protocol/frames.dart';

void main() {
  group('frame parsing tolerates malformed payloads', () {
    test('PairOk requires token, deviceId and serverFingerprint', () {
      expect(PairOk.fromJson(const {'token': 't'}), isNull);
      expect(
        PairOk.fromJson(const {
          'token': 't',
          'deviceId': 'd',
          'serverFingerprint': 'f',
        })?.token,
        't',
      );
    });

    test('PairFail falls back to unknown on a non-string reason', () {
      expect(PairFail.fromJson(const {'reason': 12}).reason, 'unknown');
    });

    test('AuthOk requires all fields', () {
      expect(AuthOk.fromJson(const {'serverName': 'x'}), isNull);
      expect(
        AuthOk.fromJson(const {
          'serverName': 'x',
          'version': '1',
          'deviceId': 'd',
        })?.version,
        '1',
      );
    });

    test('AuthFail falls back to unknown on a non-string reason', () {
      expect(AuthFail.fromJson(const {'reason': null}).reason, 'unknown');
    });
  });
}
