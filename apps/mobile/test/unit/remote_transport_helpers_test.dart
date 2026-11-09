// The live pin-mismatch classification runs inside RemoteClient's TLS
// handshake path, which needs a real socket to exercise (there is no pure
// seam for the socket outcome). These tests cover the extracted pure helpers
// that drive it instead: `computeReconnectBackoff` and
// `shouldSurfaceCertMismatch`.
import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/core/transport/remote_client.dart';

void main() {
  group('computeReconnectBackoff', () {
    test('never decreases and caps at 30 seconds', () {
      for (final jitter in [0.0, 0.25, 0.5, 0.75, 0.999]) {
        var previous = Duration.zero;
        for (var attempt = 0; attempt <= 12; attempt++) {
          final delay = computeReconnectBackoff(attempt, jitter);
          expect(
            delay >= previous,
            isTrue,
            reason: 'attempt $attempt ($delay) decreased after $previous',
          );
          expect(
            delay <= const Duration(seconds: maxReconnectBackoffSeconds),
            isTrue,
            reason: 'attempt $attempt ($delay) exceeded the cap',
          );
          previous = delay;
        }
      }
    });

    test('stays within +/-20% of the exponential base below the cap', () {
      for (var attempt = 0; attempt < 5; attempt++) {
        final base = 1 << attempt;
        final low = computeReconnectBackoff(attempt, 0.0).inSeconds;
        final high = computeReconnectBackoff(attempt, 0.999).inSeconds;
        expect(low, greaterThanOrEqualTo((base * 0.8).floor()));
        expect(high, lessThanOrEqualTo((base * 1.2).ceil()));
      }
    });

    test('is a flat 30 seconds once the cap is reached', () {
      for (var attempt = 5; attempt <= 12; attempt++) {
        expect(
          computeReconnectBackoff(attempt, 0.0),
          const Duration(seconds: maxReconnectBackoffSeconds),
        );
        expect(
          computeReconnectBackoff(attempt, 0.999),
          const Duration(seconds: maxReconnectBackoffSeconds),
        );
      }
    });
  });

  group('shouldSurfaceCertMismatch', () {
    test('requires a pinned fingerprint', () {
      expect(
        shouldSurfaceCertMismatch(hasPin: false, consecutiveFailures: 5),
        isFalse,
      );
    });

    test('requires two consecutive handshake failures', () {
      expect(
        shouldSurfaceCertMismatch(hasPin: true, consecutiveFailures: 1),
        isFalse,
      );
      expect(
        shouldSurfaceCertMismatch(hasPin: true, consecutiveFailures: 2),
        isTrue,
      );
    });
  });
}
