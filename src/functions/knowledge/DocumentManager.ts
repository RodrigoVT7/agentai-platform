import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { DocumentManagerHandler } from "../../shared/handlers/knowledge/documentManagerHandler";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function documentManager(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    const documentId = request.params.id;
    const knowledgeBaseId = request.query.get('knowledgeBaseId');
    const handler = new DocumentManagerHandler(logger);
    
    // Manejar solicitudes según el método HTTP
    switch (request.method) {
      case 'GET':
        if (documentId) {
          // Obtener detalles de un documento específico
          return await handler.getDocument(documentId, userId);
        } else if (knowledgeBaseId) {
          // Listar documentos para una base de conocimiento
          const limit = parseInt(request.query.get('limit') || '10');
          const skip = parseInt(request.query.get('skip') || '0');
          const status = request.query.get('status');
          
          return await handler.listDocuments(knowledgeBaseId, userId, { limit, skip, status });
        } else {
          return {
            status: 400,
            jsonBody: { error: "Se requiere knowledgeBaseId para listar documentos" }
          };
        }
      
      case 'DELETE':
        // Eliminar un documento
        if (!documentId) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID del documento" }
          };
        }
        
        return await handler.deleteDocument(documentId, userId);
      
      case 'POST':
        // Operaciones especiales (regenerar vectores, etc.)
        if (!documentId) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere ID del documento" }
          };
        }
        
        const actionData = await request.json();
        const action = actionData.action;
        
        if (!action) {
          return {
            status: 400,
            jsonBody: { error: "Se requiere una acción para realizar" }
          };
        }
        
        switch (action) {
          case 'reprocess':
            return await handler.reprocessDocument(documentId, userId);
          
          default:
            return {
              status: 400,
              jsonBody: { error: `Acción desconocida: ${action}` }
            };
        }
      
      default:
        return {
          status: 405,
          jsonBody: { error: "Método no permitido" }
        };
    }
  } catch (error) {
    logger.error('Error en DocumentManager:', error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('documentManager', {
  methods: ['GET', 'DELETE', 'POST'],
  authLevel: 'anonymous',
  route: 'knowledge/documents/{id?}',
  handler: documentManager
});