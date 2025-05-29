// src/functions/handoff/AgentMessaging.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentMessagingHandler } from "../../shared/handlers/handoff/agentMessagingHandler";
import { AgentMessagingValidator } from "../../shared/validators/handoff/agentMessagingValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { RoleType } from "../../shared/models/userRole.model"; // Necesario para verificar roles
import { AgentMessageRequest } from "../../shared/models/handoff.model"; // Importar el tipo específico
import { MessageType } from "../../shared/models/conversation.model"; // Importar el enum

export async function AgentMessaging(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación (agente humano)
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, jsonBody: { error: "Se requiere autenticación" } };
    }

    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
      // Verificar rol AGENT o ADMIN (Descomentar y adaptar cuando tengas la función)
      // const userRoles = await getUserRoles(payload.userId);
      // if (!userRoles?.includes(RoleType.AGENT) && !userRoles?.includes(RoleType.ADMIN)) {
      //    return { status: 403, jsonBody: { error: "Permiso denegado para enviar mensajes" } };
      // }
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId;
    if (!agentUserId) {
      return { status: 401, jsonBody: { error: "Token no contiene userId" } };
    }

    // Obtener datos del cuerpo y ASIGNAR EL TIPO CORRECTO
    // Usamos 'as any' primero y luego creamos el objeto tipado
    const rawMessageData = await request.json() as any;
    const messageData: AgentMessageRequest = {
        handoffId: rawMessageData.handoffId,
        content: rawMessageData.content,
        // CORRECCIÓN: Asegurar que messageType es del tipo Enum o undefined
        messageType: rawMessageData.messageType ? rawMessageData.messageType as MessageType : undefined,
        attachments: rawMessageData.attachments
    };

    // Validar datos
    const validator = new AgentMessagingValidator(logger);
    const validationResult = await validator.validate(messageData, agentUserId);

    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }

    // Enviar mensaje
    const handler = new AgentMessagingHandler(logger);
    // CORRECCIÓN: messageData ya tiene el tipo correcto aquí
    const result = await handler.execute(messageData, agentUserId);

    return {
      status: 201,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al enviar mensaje de agente:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentMessaging', {
  methods: ['POST'],
  authLevel: 'anonymous', // Auth manual vía JWT
  route: 'handoff/messages',
  handler: AgentMessaging
});