// src/functions/agents/AgentRoles.ts (corregido)
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AgentRolesHandler } from "../../shared/handlers/agents/agentRolesHandler";
import { AgentRolesValidator } from "../../shared/validators/agents/agentRolesValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function AgentRoles(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Manejar según el método HTTP
    const handler = new AgentRolesHandler(logger);
    
    if (request.method === 'GET') {
      // Listar roles del agente
      const result = await handler.listRoles(agentId, userId);
      return {
        status: 200,
        jsonBody: result
      };
    } else if (request.method === 'POST') {
      // Asignar nuevo rol
      const roleData = await request.json() as Record<string, any>;
      
      // Validar datos
      const validator = new AgentRolesValidator(logger);
      const validationResult = await validator.validate(agentId, userId, roleData);
      
      if (!validationResult.isValid) {
        return {
          status: 400,
          jsonBody: { error: "Datos inválidos", details: validationResult.errors }
        };
      }
      
      // Asignar rol
      const result = await handler.assignRole(agentId, userId, roleData);
      return {
        status: 201,
        jsonBody: result
      };
    } else if (request.method === 'DELETE') {
      // Revocar rol
      const targetUserId = request.query.get('targetUserId');
      
      if (!targetUserId) {
        return {
          status: 400,
          jsonBody: { error: "Se requiere el ID del usuario objetivo" }
        };
      }
      
      const result = await handler.revokeRole(agentId, userId, targetUserId);
      return {
        status: 200,
        jsonBody: result
      };
    } else {
      return {
        status: 405,
        jsonBody: { error: "Método no permitido" }
      };
    }
  } catch (error) {
    logger.error("Error en gestión de roles:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('AgentRoles', {
  methods: ['GET', 'POST', 'DELETE'],
  authLevel: 'anonymous',
  route: 'agents/{id}/roles',
  handler: AgentRoles
});