import 'package:flutter/material.dart';

import 'screens/connect_screen.dart';
import 'screens/home_shell.dart';
import 'screens/splash_screen.dart';
import 'state/app_controller.dart';

class FraktoleRemoteApp extends StatefulWidget {
  const FraktoleRemoteApp({super.key, required this.controller});

  final AppController controller;

  @override
  State<FraktoleRemoteApp> createState() => _FraktoleRemoteAppState();
}

class _FraktoleRemoteAppState extends State<FraktoleRemoteApp> {
  @override
  void initState() {
    super.initState();
    widget.controller.init();
  }

  @override
  void dispose() {
    widget.controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Fraktole Remote',
      theme: ThemeData(
        brightness: Brightness.dark,
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF7C5CFF),
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        pageTransitionsTheme: const PageTransitionsTheme(builders: {
          TargetPlatform.android: FadePageTransitionBuilder(),
          TargetPlatform.iOS: FadePageTransitionBuilder(),
        }),
      ),
      home: ListenableBuilder(
        listenable: widget.controller,
        builder: (context, _) {
          return AnimatedSwitcher(
            duration: const Duration(milliseconds: 300),
            transitionBuilder: (child, animation) {
              return FadeTransition(
                opacity: animation,
                child: child,
              );
            },
            child: _buildCurrentScreen(context),
          );
        },
      ),
    );
  }

  Widget _buildCurrentScreen(BuildContext context) {
    switch (widget.controller.phase) {
      case AppPhase.connected:
        return HomeShell(
          key: const ValueKey('home'),
          controller: widget.controller,
        );
      case AppPhase.pairing:
      case AppPhase.needsPairing:
      case AppPhase.authFailed:
      case AppPhase.certMismatch:
        return ConnectScreen(
          key: const ValueKey('connect'),
          controller: widget.controller,
        );
      case AppPhase.connecting:
        return SplashScreen(
          key: const ValueKey('splash'),
          controller: widget.controller,
          label: widget.controller.stored == null
              ? 'Connecting…'
              : 'Connecting to ${widget.controller.stored!.host}…',
        );
    }
  }
}
