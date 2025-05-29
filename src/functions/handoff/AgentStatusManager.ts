// src/functions/handoff/AgentStatusManager.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentStatusManagerHandler } from "../../shared/handlers/handoff/agentStatusManagerHandler";
import { AgentStatusManagerValidator } from "../../shared/validators/handoff/agentStatusManagerValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { RoleType } from "../../shared/models/userRole.model"; // Necesario para verificar roles
import { AgentStatus, AgentStatusUpdateRequest } from "../../shared/models/handoff.model"; // Importar el tipo y enum

export async function AgentStatusManager(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
      // Verificar rol AGENT o ADMIN (Descomentar y adaptar)
      // const userRoles = await getUserRoles(payload.userId);
      // if (!userRoles?.includes(RoleType.AGENT) && !userRoles?.includes(RoleType.ADMIN)) {
      //    return { status: 403, jsonBody: { error: "Permiso denegado para gestionar estado" } };
      // }
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId;
    if (!agentUserId) {
      return { status: 401, jsonBody: { error: "Token no contiene userId" } };
    }

    const handler = new AgentStatusManagerHandler(logger);
    let result;

    // Manejar GET para obtener estado actual, POST/PUT para actualizar
    if (request.method === 'GET') {
        // Obtener ID del agente de la ruta o query param (o usar el del token)
        const targetAgentId = request.params.agentId || request.query.get('agentId') || agentUserId;

        // Podrías necesitar verificar si el usuario solicitante puede ver el estado de otro agente (si es admin)
        // if (targetAgentId !== agentUserId && !userRoles?.includes(RoleType.ADMIN)) {
        //     return { status: 403, jsonBody: { error: "No puedes ver el estado de otros agentes." } };
        // }

        result = await handler.getStatus(targetAgentId);
        return { status: 200, jsonBody: result };

    } else if (request.method === 'POST' || request.method === 'PUT') {
        // Obtener datos del cuerpo y ASIGNAR EL TIPO CORRECTO
        const rawStatusData = await request.json() as any;
        const statusData: AgentStatusUpdateRequest = {
            status: rawStatusData.status as AgentStatus, // Cast al Enum
            message: rawStatusData.message
        };

        // Validar datos
        const validator = new AgentStatusManagerValidator(logger);
        // CORRECCIÓN: Pasar el objeto con el tipo correcto
        const validationResult = await validator.validate(statusData);

        if (!validationResult.isValid) {
            return {
                status: 400,
                jsonBody: { error: "Datos inválidos", details: validationResult.errors }
            };
        }

        // Actualizar estado (el handler debe usar el agentUserId del token)
        // CORRECCIÓN: Pasar el valor del Enum validado
        result = await handler.updateStatus(agentUserId, statusData.status, statusData.message);
        return { status: 200, jsonBody: result };
    } else {
         return { status: 405, jsonBody: { error: "Método no permitido" } };
    }

  } catch (error) {
    logger.error("Error al gestionar estado del agente:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

// --- Registros de Funciones (sin cambios, pero asegúrate de que las rutas sean correctas) ---
app.http('AgentStatusManager', {
  methods: ['GET', 'POST', 'PUT'], // GET para leer, POST/PUT para actualizar
  authLevel: 'anonymous', // Auth manual vía JWT
  route: 'handoff/agents/{agentId}/status', // Ruta para obtener/actualizar estado de un agente específico
  handler: AgentStatusManager
});

app.http('MyAgentStatusManager', {
  methods: ['GET', 'POST', 'PUT'],
  authLevel: 'anonymous',
  route: 'handoff/status', // Ruta más simple para el propio estado
  handler: AgentStatusManager // Reutiliza el mismo handler
});