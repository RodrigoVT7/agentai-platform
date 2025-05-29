// src/functions/handoff/HandoffCompletion.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { HandoffCompletionHandler } from "../../shared/handlers/handoff/handoffCompletionHandler";
import { HandoffCompletionValidator } from "../../shared/validators/handoff/handoffCompletionValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { RoleType } from "../../shared/models/userRole.model"; // Necesario para verificar roles

export async function HandoffCompletion(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
      // Verificar rol AGENT o ADMIN
      // const userRoles = await getUserRoles(payload.userId); // Implementar
      // if (!userRoles.includes(RoleType.AGENT) && !userRoles.includes(RoleType.ADMIN)) {
      //    return { status: 403, jsonBody: { error: "Permiso denegado para completar handoffs" } };
      // }
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId;
    if (!agentUserId) {
      return { status: 401, jsonBody: { error: "Token no contiene userId" } };
    }

    // Obtener datos del cuerpo
    const completionData = await request.json() as { handoffId: string; summary?: string; resolution?: string }; // Define interfaz

    // Validar datos
    const validator = new HandoffCompletionValidator(logger);
    // Pasar agentUserId para verificar que es el agente asignado
    const validationResult = await validator.validate(completionData, agentUserId);

    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }

    // Completar handoff
    const handler = new HandoffCompletionHandler(logger);
    const result = await handler.execute(completionData, agentUserId);

    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al completar handoff:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('HandoffCompletion', {
  methods: ['POST'],
  authLevel: 'anonymous', // Auth manual vía JWT
  route: 'handoff/complete',
  handler: HandoffCompletion
});