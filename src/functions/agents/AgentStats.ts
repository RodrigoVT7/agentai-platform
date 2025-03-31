// src/functions/agents/AgentStats.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentStatsHandler } from "../../shared/handlers/agents/agentStatsHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function AgentStats(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener parámetros
    const period = request.query.get('period') || 'day'; // day, week, month
    const from = request.query.get('from') ? parseInt(request.query.get('from')!) : undefined;
    const to = request.query.get('to') ? parseInt(request.query.get('to')!) : undefined;
    
    // Obtener estadísticas
    const handler = new AgentStatsHandler(logger);
    const result = await handler.execute(agentId, userId, { period, from, to });
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al obtener estadísticas:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentStats', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'agents/{id}/stats',
  handler: AgentStats
});