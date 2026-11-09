import 'dart:convert';

class RpcRequest {
  const RpcRequest({required this.id, required this.method, this.params = const {}});

  final int id;
  final String method;
  final Map<String, Object?> params;

  Map<String, Object?> toJson() => {'id': id, 'method': method, 'params': params};

  String encode() => jsonEncode(toJson());
}

class RpcError implements Exception {
  const RpcError({required this.code, required this.message});

  final int code;
  final String message;

  @override
  String toString() => 'RpcError($code): $message';
}

class RpcResponse {
  const RpcResponse({required this.id, this.result, this.error});

  final int id;
  final Object? result;
  final RpcError? error;

  bool get isError => error != null;

  static RpcResponse? fromJson(Map<String, Object?> json) {
    if (json['id'] is! int) return null;
    final id = json['id'] as int;
    if (json['result'] != null) {
      return RpcResponse(id: id, result: json['result']);
    }
    final err = json['error'];
    if (err is Map<String, Object?>) {
      final code = err['code'];
      final message = err['message'];
      return RpcResponse(
        id: id,
        error: RpcError(
          code: code is int ? code : -32000,
          message: message is String ? message : 'unknown error',
        ),
      );
    }
    return null;
  }
}

abstract final class RpcErrorCodes {
  static const int parse = -32700;
  static const int notAuthenticated = -32000;
  static const int unknownMethod = -32601;
  static const int timeout = -32001;
  static const int connectionClosed = -32002;
}
