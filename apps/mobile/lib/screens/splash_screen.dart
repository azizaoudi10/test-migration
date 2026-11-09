import 'package:flutter/material.dart';

import '../core/transport/remote_gateway.dart';
import '../state/app_controller.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({super.key, required this.controller, required this.label});

  final AppController controller;
  final String label;

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _fadeController;
  late final Animation<double> _fadeAnimation;

  @override
  void initState() {
    super.initState();
    _fadeController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 500),
    );
    _fadeAnimation = CurvedAnimation(
      parent: _fadeController,
      curve: Curves.easeInOut,
    );
    _fadeController.forward();
  }

  @override
  void dispose() {
    _fadeController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              FadeTransition(
                opacity: _fadeAnimation,
                child: const SizedBox(
                  width: 48,
                  height: 48,
                  child: CircularProgressIndicator(strokeWidth: 3),
                ),
              ),
              const SizedBox(height: 24),
              FadeTransition(
                opacity: _fadeAnimation,
                child: Text(label, style: Theme.of(context).textTheme.bodyLarge),
              ),
              const SizedBox(height: 8),
              if (controller.connectionStatus == ConnectionStatus.connecting)
                FadeTransition(
                  opacity: _fadeAnimation,
                  child: TextButton(
                    onPressed: () => controller.disconnect(),
                    child: const Text('Cancel'),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}
