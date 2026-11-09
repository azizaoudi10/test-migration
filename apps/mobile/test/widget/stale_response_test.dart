import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/app.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';
import 'package:fraktole_remote/core/transport/remote_gateway.dart';
import 'package:fraktole_remote/state/app_controller.dart';

import '../helpers/fake_gateway.dart';

void main() {
  testWidgets('a stale sessions.list response cannot clobber newer state',
      (tester) async {
    final kv = InMemoryKeyValueStore();
    await ConnectionStore(kv: kv).write(StoredConnection(
      host: '192.168.1.20',
      port: 8833,
      token: 'a' * 64,
      deviceId: 'device-9',
      fingerprint: 'b' * 64,
      deviceName: 'Pixel 8',
    ));

    final gateway = FakeRemoteGateway();
    final first = Completer<Object?>();
    final second = Completer<Object?>();
    var sessionsCalls = 0;
    gateway.onRpc = (method, params) {
      if (method == 'sessions.list') {
        sessionsCalls++;
        return sessionsCalls == 1 ? first.future : second.future;
      }
      if (method == 'messages.list') return <Object?>[];
      throw RemoteException('no fake result for $method');
    };

    await tester.pumpWidget(FraktoleRemoteApp(
      controller:
          AppController(store: ConnectionStore(kv: kv), gateway: gateway),
    ));
    for (var i = 0; i < 10 && sessionsCalls == 0; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(sessionsCalls, 1);

    // a session.state event starts a second load while the first is pending
    gateway.emitSessionState('s1', alive: true);
    for (var i = 0; i < 10 && sessionsCalls < 2; i++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(sessionsCalls, 2);

    // the newer response resolves first; the stale response lands afterwards
    second.complete(<Object?>[
      {'id': 's-new', 'name': 'Newer Session', 'alive': true, 'tileCount': 1},
    ]);
    await tester.pump();
    await tester.pump();
    expect(find.text('Newer Session'), findsOneWidget);

    first.complete(<Object?>[
      {'id': 's-old', 'name': 'Stale Session', 'alive': true, 'tileCount': 1},
    ]);
    await tester.pump();
    await tester.pump();
    expect(find.text('Newer Session'), findsOneWidget);
    expect(find.text('Stale Session'), findsNothing);
  });
}
