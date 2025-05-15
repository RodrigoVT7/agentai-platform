// src/functions/conversation/ConversationHistory.ts
import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { ConversationHistoryHandler } from "../../shared/handlers/conversation/conversationHistoryHandler";
import { ConversationsListHandler } from "../../shared/handlers/conversation/conversationsListHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function ConversationHistory(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" },
      };
    }

    // Extraer y verificar token
    const token = authHeader.split(" ")[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" },
      };
    }

    const userId = payload.userId;
    if (!userId) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene userId" },
      };
    }

    // Obtener parámetros
    const conversationId = request.params.id;
    const agentId = request.query.get("agentId") || undefined;
    const limit = parseInt(request.query.get("limit") || "50");

    // Corregir manejo de null para 'before'
    const beforeStr = request.query.get("before");
    const before = beforeStr ? parseInt(beforeStr) : undefined;

    if (!conversationId) {
      return {
        status: 400,
        jsonBody: { error: "Se requiere ID de conversación" },
      };
    }

    // Obtener historial
    const handler = new ConversationHistoryHandler(logger);
    const result = await handler.execute(conversationId, userId, agentId, {
      limit,
      before,
    });

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    logger.error("Error al obtener historial de conversación:", error);

    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details },
    };
  }
}

export async function ConversationsList(
  request: HttpRequest,
  context: InvocationContext
): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" },
      };
    }

    // Extraer y verificar token
    const token = authHeader.split(" ")[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" },
      };
    }

    const userId = payload.userId;
    if (!userId) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene userId" },
      };
    }

    // Obtener parámetros
    const agentId = request.params.agentId;
    const limit = parseInt(request.query.get("limit") || "50");

    // Corregir manejo de null para 'before'
    const beforeStr = request.query.get("before");
    const before = beforeStr ? parseInt(beforeStr) : undefined;

    if (!agentId) {
      return {
        status: 400,
        jsonBody: { error: "Se requiere ID de agente" },
      };
    }

    // Obtener lista de conversaciones
    const handler = new ConversationsListHandler(logger);
    const result = await handler.execute(agentId, userId, {
      limit,
      before,
    });

    return {
      status: 200,
      jsonBody: result,
    };
  } catch (error) {
    logger.error("Error al obtener lista de conversaciones:", error);

    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details },
    };
  }
}

app.http("MessagesHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "conversation/{id}/messages",
  handler: ConversationHistory,
});

app.http("ConversationsHistory", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "agent/{agentId}/conversations",
  handler: ConversationsList,
});
