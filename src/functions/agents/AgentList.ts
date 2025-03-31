// src/functions/agents/AgentList.ts (corregido)
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentListHandler } from "../../shared/handlers/agents/agentListHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function AgentList(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener parámetros de consulta
    const limit = parseInt(request.query.get('limit') || '10');
    const skip = parseInt(request.query.get('skip') || '0');
    const search = request.query.get('search') || '';
    const statusParam = request.query.get('status') || undefined;
    
    // Crear handler
    const handler = new AgentListHandler(logger);
    const result = await handler.execute(userId, { limit, skip, search, status: statusParam });
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al listar agentes:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentList', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'agents',
  handler: AgentList
});