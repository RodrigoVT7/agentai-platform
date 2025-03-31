// src/functions/agents/AgentUpdate.ts (corregido)
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentUpdateHandler } from "../../shared/handlers/agents/agentUpdateHandler";
import { AgentUpdateValidator } from "../../shared/validators/agents/agentUpdateValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function AgentUpdate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener datos del cuerpo
    const updateData = await request.json() as Record<string, any>;
    
    // Validar datos
    const validator = new AgentUpdateValidator(logger);
    const validationResult = await validator.validate(agentId, userId, updateData);
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Datos inválidos", details: validationResult.errors }
      };
    }
    
    // Actualizar agente
    const handler = new AgentUpdateHandler(logger);
    const result = await handler.execute(agentId, userId, updateData);
    
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error("Error al actualizar agente:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentUpdate', {
  methods: ['PUT', 'PATCH'],
  authLevel: 'anonymous',
  route: 'agents/{id}',
  handler: AgentUpdate
});