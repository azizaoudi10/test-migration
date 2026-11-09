import 'package:flutter_test/flutter_test.dart';
import 'package:fraktole_remote/app.dart';
import 'package:fraktole_remote/core/security/secure_store.dart';
import 'package:fraktole_remote/core/transport/remote_gateway.dart';
import 'package:fraktole_remote/screens/home_shell.dart';
import 'package:fraktole_remote/state/app_controller.dart';

import '../helpers/fake_gateway.dart';

void main() {
  Future<FakeRemoteGateway> pumpApp(WidgetTester tester) async {
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
    gateway.onRpc = (method, params) {
      if (method == 'sessions.list') return <Object?>[];
      if (method == 'messages.list') {
        return <Object?>[
          {
            'kind': 'task',
            'from': 'orchestrator',
            'to': 'agent-1',
            'body': 'first',
            'ts': 1,
          },
        ];
      }
      throw RemoteException('no fake result for $method');
    };
    await tester.pumpWidget(FraktoleRemoteApp(
      controller:
          AppController(store: ConnectionStore(kv: kv), gateway: gateway),
    ));
    await tester.pumpAndSettle();
    return gateway;
  }

  testWidgets('a pushed message appends locally without re-listing',
      (tester) async {
    final gateway = await pumpApp(tester);
    expect(find.byType(HomeShell), findsOneWidget);
    expect(
      gateway.rpcCalls.where((method) => method == 'messages.list').length,
      1,
      reason: 'the orchestrator loads the mailbox once on first build',
    );

    gateway.emitMessageNew({
      'kind': 'result',
      'from': 'agent-1',
      'to': 'orchestrator',
      'body': 'pushed-body',
      'ts': 2,
    });
    await tester.pump();

    expect(
      gateway.rpcCalls.where((method) => method == 'messages.list').length,
      1,
      reason: 'message.new must not trigger a full messages.list refresh',
    );

    // the pushed message badged the tab; viewing it must show both entries
    await tester.tap(find.text('Orchestrator 1'));
    await tester.pumpAndSettle();
    expect(find.text('first'), findsOneWidget);
    expect(find.text('pushed-body'), findsOneWidget);
  });
}
