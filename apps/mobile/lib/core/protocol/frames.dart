import 'dart:convert';

class PairFrame {
  const PairFrame({required this.code, required this.deviceName});

  final String code;
  final String deviceName;

  Map<String, Object?> toJson() => {
        'type': 'pair',
        'code': code,
        'deviceName': deviceName,
      };

  String encode() => jsonEncode(toJson());
}

class AuthFrame {
  const AuthFrame({required this.token});

  final String token;

  Map<String, Object?> toJson() => {'type': 'auth', 'token': token};

  String encode() => jsonEncode(toJson());
}

class PongFrame {
  const PongFrame({required this.params});

  final Map<String, Object?> params;

  Map<String, Object?> toJson() => {'type': 'pong', 'params': params};

  String encode() => jsonEncode(toJson());
}

class PairOk {
  const PairOk({
    required this.token,
    required this.deviceId,
    required this.serverFingerprint,
  });

  final String token;
  final String deviceId;
  final String serverFingerprint;

  static PairOk? fromJson(Map<String, Object?> json) {
    final token = json['token'];
    final deviceId = json['deviceId'];
    final serverFingerprint = json['serverFingerprint'];
    if (token is! String ||
        deviceId is! String ||
        serverFingerprint is! String) {
      return null;
    }
    return PairOk(
      token: token,
      deviceId: deviceId,
      serverFingerprint: serverFingerprint,
    );
  }
}

class PairFail {
  const PairFail({required this.reason});

  final String reason;

  static PairFail fromJson(Map<String, Object?> json) {
    final reason = json['reason'];
    return PairFail(reason: reason is String ? reason : 'unknown');
  }
}

class AuthOk {
  const AuthOk({
    required this.serverName,
    required this.version,
    required this.deviceId,
  });

  final String serverName;
  final String version;
  final String deviceId;

  static AuthOk? fromJson(Map<String, Object?> json) {
    final serverName = json['serverName'];
    final version = json['version'];
    final deviceId = json['deviceId'];
    if (serverName is! String || version is! String || deviceId is! String) {
      return null;
    }
    return AuthOk(serverName: serverName, version: version, deviceId: deviceId);
  }
}

class AuthFail {
  const AuthFail({required this.reason});

  final String reason;

  static AuthFail fromJson(Map<String, Object?> json) {
    final reason = json['reason'];
    return AuthFail(reason: reason is String ? reason : 'unknown');
  }
}
