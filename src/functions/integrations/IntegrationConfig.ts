// src/functions/integrations/IntegrationConfig.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { IntegrationConfigHandler } from "../../shared/handlers/integrations/integrationConfigHandler";
import { IntegrationConfigValidator } from "../../shared/validators/integrations/integrationConfigValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function IntegrationConfig(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener ID de integración si está en la URL (para GET, PUT, DELETE)
    const integrationId = request.params.id;
    
    // Crear handler y validator
    const handler = new IntegrationConfigHandler(logger);
    const validator = new IntegrationConfigValidator(logger);
    
    // Manejar según el método HTTP
    switch (request.method) {
      case 'GET':
        if (integrationId) {
          // Obtener una integración específica
          return await handler.getIntegration(integrationId, userId);
        } else {
          // Listar integraciones para un agente
          const agentId = request.query.get('agentId');
          if (!agentId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere agentId para listar integraciones" }
            };
          }
          return await handler.listIntegrations(agentId, userId);
        }
      
      case 'POST':
        // Crear nueva integración
        const createData = await request.json();
        
        // Validar datos
        const createValidation = await validator.validateCreate(createData, userId);
        if (!createValidation.isValid) {
          return {
            status: 400,
            jsonBody: { error: "Datos inválidos", details: createValidation.errors }
          };
        }
        
        return await handler.createIntegration(createData, userId);
      
      case 'PUT':
        // Actualizar integración existente
        if (!integrationId) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID de la integración" }
          };
        }
        
        const updateData = await request.json();
        
        // Validar datos
        const updateValidation = await validator.validateUpdate(integrationId, updateData, userId);
        if (!updateValidation.isValid) {
          return {
            status: 400,
            jsonBody: { error: "Datos inválidos", details: updateValidation.errors }
          };
        }
        
        return await handler.updateIntegration(integrationId, updateData, userId);
      
      case 'DELETE':
        // Desactivar integración
        if (!integrationId) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID de la integración" }
          };
        }
        
        return await handler.deleteIntegration(integrationId, userId);
      
      default:
        return {
          status: 405,
          jsonBody: { error: "Método no permitido" }
        };
    }
  } catch (error) {
    logger.error("Error en gestión de integración:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('IntegrationConfig', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'integrations/config/{id?}',
  handler: IntegrationConfig
});