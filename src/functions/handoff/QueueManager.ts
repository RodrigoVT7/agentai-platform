// src/functions/handoff/QueueManager.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { QueueManagerHandler } from "../../shared/handlers/handoff/queueManagerHandler";
import { QueueManagerValidator } from "../../shared/validators/handoff/queueManagerValidator"; // Asegúrate de importar si lo creaste
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { RoleType } from "../../shared/models/userRole.model"; // Necesario para verificar roles

export async function QueueManager(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);

  try {
    // Verificar autenticación (debe ser un agente humano o admin)
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { status: 401, jsonBody: { error: "Se requiere autenticación" } };
    }

    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();

    let payload;
    try {
      payload = jwtService.verifyToken(token);
      // Verificar si el usuario tiene rol adecuado (ej. AGENT o ADMIN) - Descomentar y adaptar
      // const userRoles = await getUserRoles(payload.userId);
      // if (!userRoles?.includes(RoleType.AGENT) && !userRoles?.includes(RoleType.ADMIN)) {
      //    return { status: 403, jsonBody: { error: "Permiso denegado para ver la cola" } };
      // }
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const userId = payload.userId;
    if (!userId) {
      return { status: 401, jsonBody: { error: "Token no contiene userId" } };
    }

    // Obtener parámetros de consulta (filtros, paginación, etc.)
    // CORRECCIÓN: Convertir null a undefined para que coincida con el tipo esperado
    const agentId = request.query.get('agentId') || undefined;
    const status = request.query.get('status') || undefined;
    const limit = parseInt(request.query.get('limit') || '20');
    const skip = parseInt(request.query.get('skip') || '0');

    // Validar filtros si es necesario (usando el validator)
    const validator = new QueueManagerValidator(logger);
    const validationResult = validator.validate({ agentId, status, limit, skip });
    if (!validationResult.isValid) {
        return {
             status: 400,
             jsonBody: { error: "Filtros inválidos", details: validationResult.errors }
        };
    }

    // Obtener la cola
    const handler = new QueueManagerHandler(logger);
    // CORRECCIÓN: Pasar el objeto con los tipos correctos
    const result = await handler.execute({ agentId, status, limit, skip }, userId);

    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al gestionar la cola de handoff:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('QueueManager', {
  methods: ['GET'],
  authLevel: 'anonymous', // Auth manual vía JWT
  route: 'handoff/queue',
  handler: QueueManager
});