// src/functions/agents/AgentDelete.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentDeleteHandler } from "../../shared/handlers/agents/agentDeleteHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function AgentDelete(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" }
      };
    }
    
    // Extraer y verificar token
    const token = authHeader.split(' ')[1];
    const jwtService = new JwtService();
    
    let payload;
    try {
      payload = jwtService.verifyToken(token);
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" }
      };
    }
    
    const userId = payload.userId;
    if (!userId) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene userId" }
      };
    }
    
    // Obtener ID del agente de la URL
    const agentId = request.params.id;
    if (!agentId) {
      return {
        status: 400,
        jsonBody: { error: "Se requiere el ID del agente" }
      };
    }
    
    // Eliminar agente (lógicamente)
    const handler = new AgentDeleteHandler(logger);
    const result = await handler.execute(agentId, userId);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al eliminar agente:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentDelete', {
  methods: ['DELETE'],
  authLevel: 'anonymous',
  route: 'agents/{id}',
  handler: AgentDelete
});