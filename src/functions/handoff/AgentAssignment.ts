// src/functions/handoff/AgentAssignment.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentAssignmentHandler } from "../../shared/handlers/handoff/agentAssignmentHandler";
import { AgentAssignmentValidator } from "../../shared/validators/handoff/agentAssignmentValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";
import { RoleType } from "../../shared/models/userRole.model"; // Necesario para verificar roles

export async function AgentAssignment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
      // Verificar rol adecuado (AGENT o ADMIN)
      // const userRoles = await getUserRoles(payload.userId); // Implementar esta función
      // if (!userRoles.includes(RoleType.AGENT) && !userRoles.includes(RoleType.ADMIN)) {
      //    return { status: 403, jsonBody: { error: "Permiso denegado para asignar conversaciones" } };
      // }
    } catch (error) {
      return { status: 401, jsonBody: { error: "Token inválido o expirado" } };
    }

    const agentUserId = payload.userId; // ID del agente humano que toma la conversación
    if (!agentUserId) {
      return { status: 401, jsonBody: { error: "Token no contiene userId" } };
    }

    // Obtener datos del cuerpo (handoffId)
    const assignmentData = await request.json() as { handoffId: string }; // Define interfaz fuerte

    // Validar datos
    const validator = new AgentAssignmentValidator(logger);
    // Pasar agentUserId para verificar que el agente está disponible/puede tomarla
    const validationResult = await validator.validate(assignmentData, agentUserId);

    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }

    // Asignar agente
    const handler = new AgentAssignmentHandler(logger);
    const result = await handler.execute(assignmentData.handoffId, agentUserId);

    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al asignar agente:", error);
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentAssignment', {
  methods: ['POST'],
  authLevel: 'anonymous', // Auth manual vía JWT
  route: 'handoff/assign',
  handler: AgentAssignment
});