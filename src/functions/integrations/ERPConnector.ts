// src/functions/integrations/ERPConnector.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ERPConnectorHandler } from "../../shared/handlers/integrations/erpConnectorHandler";
import { ERPConnectorValidator } from "../../shared/validators/integrations/erpConnectorValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function ERPConnector(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener ID de integración si está en URL y action
    const integrationId = request.params.id;
    const action = request.params.action;
    const erpType = request.query.get('type'); // sap, dynamics, odoo, etc.
    
    // Crear handler y validator
    const handler = new ERPConnectorHandler(logger);
    const validator = new ERPConnectorValidator(logger);
    
    // Manejar según el método HTTP y la acción
    switch (request.method) {
      case 'GET':
        if (action === 'schemas') {
          // Obtener esquemas disponibles para un tipo de ERP
          if (!erpType) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere tipo de ERP" }
            };
          }
          
          return await handler.getSchemas(erpType);
        } else if (action === 'entities') {
          // Obtener entidades según esquema
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const schema = request.query.get('schema') || 'default';
          return await handler.getEntities(integrationId, schema, userId);
        } else if (action === 'data') {
          // Consultar datos de una entidad
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const entity = request.query.get('entity');
          if (!entity) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere nombre de entidad" }
            };
          }
          
          const filter = request.query.get('filter');
          const limit = parseInt(request.query.get('limit') || '100');
          
          return await handler.queryData(integrationId, entity, userId, {
            filter: filter || undefined,
            limit
          });
        } else if (action === 'test') {
          // Probar conexión
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          return await handler.testConnection(integrationId, userId);
        } else if (integrationId) {
          // Obtener detalles de integración
          return await handler.getIntegration(integrationId, userId);
        } else {
          return {
            status: 400,
            jsonBody: { error: "Acción no válida o falta ID de integración" }
          };
        }
      
      case 'POST':
        if (action === 'data') {
          // Crear nuevo registro
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const createData = await request.json();
          const entity = request.query.get('entity');
          
          if (!entity) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere nombre de entidad" }
            };
          }
          
          // Validar datos según esquema
          const dataValidation = await validator.validateEntityData(integrationId, entity, createData, userId);
          if (!dataValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: dataValidation.errors }
            };
          }
          
          return await handler.createRecord(integrationId, entity, createData, userId);
        } else if (action === 'query') {
          // Ejecutar consulta personalizada
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const queryData = await request.json();
          
          // Validar datos de consulta
          const queryValidation = await validator.validateQuery(queryData);
          if (!queryValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Consulta inválida", details: queryValidation.errors }
            };
          }
          
          return await handler.executeQuery(integrationId, queryData, userId);
        } else {
          // Crear nueva integración
          const integrationData = await request.json();
          
          // Validar datos de integración
          const integrationValidation = await validator.validateIntegration(integrationData, userId);
          if (!integrationValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: integrationValidation.errors }
            };
          }
          
          return await handler.createIntegration(integrationData, userId);
        }
      
      case 'PUT':
        if (action === 'data') {
          // Actualizar registro existente
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const updateData = await request.json();
          const entity = request.query.get('entity');
          const recordId = request.query.get('id');
          
          if (!entity || !recordId) {
            return {
              status: 400,
              jsonBody: { error: "Se requieren entidad e ID del registro" }
            };
          }
          
          // Validar datos según esquema
          const dataValidation = await validator.validateEntityData(integrationId, entity, updateData, userId);
          if (!dataValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: dataValidation.errors }
            };
          }
          
          return await handler.updateRecord(integrationId, entity, recordId, updateData, userId);
        } else if (integrationId) {
          // Actualizar configuración de integración
          const updateData = await request.json();
          
          // Validar datos de actualización
          const updateValidation = await validator.validateUpdate(updateData);
          if (!updateValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: updateValidation.errors }
            };
          }
          
          return await handler.updateIntegration(integrationId, updateData, userId);
        } else {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID de la integración" }
          };
        }
      
      case 'DELETE':
        if (action === 'data') {
          // Eliminar registro
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const entity = request.query.get('entity');
          const recordId = request.query.get('id');
          
          if (!entity || !recordId) {
            return {
              status: 400,
              jsonBody: { error: "Se requieren entidad e ID del registro" }
            };
          }
          
          return await handler.deleteRecord(integrationId, entity, recordId, userId);
        } else if (integrationId) {
          // Desactivar integración
          return await handler.deleteIntegration(integrationId, userId);
        } else {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID de la integración" }
          };
        }
      
      default:
        return {
          status: 405,
          jsonBody: { error: "Método no permitido" }
        };
    }
  } catch (error) {
    logger.error("Error en integración ERP:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('ERPConnector', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'integrations/erp/{id?}/{action?}',
  handler: ERPConnector
});