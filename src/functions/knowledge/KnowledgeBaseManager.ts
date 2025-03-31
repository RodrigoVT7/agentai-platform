import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { KnowledgeBaseManagerHandler } from "../../shared/handlers/knowledge/knowledgeBaseManagerHandler";
import { KnowledgeBaseValidator } from "../../shared/validators/knowledge/knowledgeBaseValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function knowledgeBaseManager(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    const token = authHeader.substring(7);
    let userId: string;
    
    try {
      const jwtService = new JwtService();
      const decodedToken = jwtService.verifyToken(token);
      userId = decodedToken.userId;
    } catch (error) {
      return {
        status: 401,
        jsonBody: { error: "Token inválido o expirado" }
      };
    }
    
    const knowledgeBaseId = request.params.id;
    const agentId = request.query.get('agentId');
    const handler = new KnowledgeBaseManagerHandler(logger);
    const validator = new KnowledgeBaseValidator(logger);
    
    // Manejar solicitudes según el método HTTP
    switch (request.method) {
      case 'GET':
        if (knowledgeBaseId) {
          // Obtener una KB específica
          return await handler.getKnowledgeBase(knowledgeBaseId, userId);
        } else if (agentId) {
          // Listar KBs para un agente
          return await handler.listKnowledgeBases(agentId, userId);
        } else {
          return {
            status: 400,
            jsonBody: { error: "Se requiere agentId para listar bases de conocimiento" }
          };
        }
      
      case 'POST':
        // Crear nueva KB
        const createData = await request.json();
        
        // Validar datos
        const createValidation = await validator.validateCreate(createData, userId);
        if (!createValidation.isValid) {
          return {
            status: 400,
            jsonBody: { error: "Datos inválidos", details: createValidation.errors }
          };
        }
        
        return await handler.createKnowledgeBase(createData, userId);
      
      case 'PUT':
        // Actualizar KB existente
        if (!knowledgeBaseId) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID de la base de conocimiento" }
          };
        }
        
        const updateData = await request.json();
        
        // Validar datos
        const updateValidation = await validator.validateUpdate(knowledgeBaseId, updateData, userId);
        if (!updateValidation.isValid) {
          return {
            status: 400,
            jsonBody: { error: "Datos inválidos", details: updateValidation.errors }
          };
        }
        
        return await handler.updateKnowledgeBase(knowledgeBaseId, updateData, userId);
      
      case 'DELETE':
        // Eliminar KB
        if (!knowledgeBaseId) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID de la base de conocimiento" }
          };
        }
        
        return await handler.deleteKnowledgeBase(knowledgeBaseId, userId);
      
      default:
        return {
          status: 405,
          jsonBody: { error: "Método no permitido" }
        };
    }
  } catch (error) {
    logger.error('Error en KnowledgeBaseManager:', error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('knowledgeBaseManager', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'knowledge/bases/{id?}',
  handler: knowledgeBaseManager
});