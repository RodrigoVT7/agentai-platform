// src/functions/knowledge/DocumentManager.ts
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
          const status = request.query.get('status') || undefined;
          
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
        
        // Verificar el Content-Type de la solicitud
        const contentType = request.headers.get('content-type') || '';
        
        // Si es form-data, rechaza explícitamente (este endpoint no maneja archivos)
        if (contentType.includes('multipart/form-data')) {
          return {
            status: 415, // Unsupported Media Type
            jsonBody: { 
              error: "Este endpoint no acepta form-data", 
              message: "Para subir archivos, use /knowledge/documents/upload"
            }
          };
        }
        
        // Para solicitudes JSON
        if (!contentType.includes('application/json')) {
          return {
            status: 400,
            jsonBody: { 
              error: "Content-Type debe ser application/json" 
            }
          };
        }
        
        // Intentar parsear JSON con seguridad
        let actionData;
        try {
          // Obtener el cuerpo como texto para inspeccionar
          const bodyText = await request.text();
          logger.info(`Cuerpo de la solicitud: ${bodyText}`);
          
          // Intentar parsear JSON manualmente
          if (!bodyText || bodyText.trim() === '') {
            return {
              status: 400,
              jsonBody: { error: "El cuerpo de la solicitud está vacío" }
            };
          }
          
          try {
            actionData = JSON.parse(bodyText);
          } catch (parseError) {
            return {
              status: 400,
              jsonBody: { 
                error: "Error al parsear JSON. Asegúrate de enviar un JSON válido",
                details: parseError instanceof Error ? parseError.message : String(parseError)
              }
            };
          }
        } catch (readError) {
          logger.error(`Error al leer el cuerpo de la solicitud: ${readError}`);
          return {
            status: 400,
            jsonBody: { 
              error: "Error al leer el cuerpo de la solicitud",
              details: readError instanceof Error ? readError.message : String(readError)
            }
          };
        }
        
        // Verificar que actionData es un objeto y tiene la propiedad action
        if (!actionData || typeof actionData !== 'object') {
          return {
            status: 400,
            jsonBody: { error: "Se requiere una acción para realizar" }
          };
        }

        const action = (actionData as { action?: string }).action;
        
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
  route: 'knowledge/documents/detail/{id?}',  // Cambiar a una ruta más específica
  handler: documentManager
});