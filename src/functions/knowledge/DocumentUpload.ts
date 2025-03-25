// src/functions/knowledge/DocumentUpload.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { DocumentUploadHandler } from "../../shared/handlers/knowledge/documentUploadHandler";
import { DocumentUploadValidator } from "../../shared/validators/knowledge/documentUploadValidator";
import { DocumentUploadRequest } from "../../shared/models/document.model";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function documentUpload(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Verificar autenticación via JWT
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
    
    // Obtener parámetros de la consulta
    const agentId = request.query.get('agentId');
    const knowledgeBaseId = request.query.get('knowledgeBaseId');
    
    if (!agentId || !knowledgeBaseId) {
      return {
        status: 400,
        jsonBody: { error: "Se requieren los parámetros agentId y knowledgeBaseId" }
      };
    }
    
    // Verificar permiso del usuario para este agente
    const validator = new DocumentUploadValidator(logger);
    
    // Verificar si el usuario tiene acceso al agente
    const hasAccess = await validator.validateAgentAccess(userId, agentId);
    
    if (!hasAccess) {
      return {
        status: 403,
        jsonBody: { error: "No tienes permiso para acceder a este agente" }
      };
    }
    
    // Obtener y validar el archivo
    let fileData: DocumentUploadRequest;
    
    try {
      // Parsear el cuerpo de la solicitud como FormData
      const formData = await request.formData();
      const fileEntry = formData.get('file');
      
      if (!fileEntry || !(fileEntry instanceof Blob)) {
        return {
          status: 400,
          jsonBody: { error: "No se ha proporcionado ningún archivo válido" }
        };
      }
      
      // Obtener nombre y tipo del archivo
      const originalname = (fileEntry as any).name || 'unknown-file';
      const mimetype = fileEntry.type || 'application/octet-stream';
      
      // Convertir Blob a Buffer
      const arrayBuffer = await fileEntry.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      
      fileData = {
        buffer,
        originalname,
        mimetype,
        size: buffer.length
      };
    } catch (error) {
      logger.error("Error al procesar el archivo:", error);
      return {
        status: 400,
        jsonBody: { error: "Error al procesar el archivo enviado" }
      };
    }
    
    // Validar archivo
    const fileValidation = validator.validate(fileData);
    
    if (!fileValidation.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Archivo inválido", details: fileValidation.errors }
      };
    }
    
    // Procesar el archivo
    const handler = new DocumentUploadHandler(logger);
    const result = await handler.execute(fileData, userId, agentId, knowledgeBaseId);
    
    // Responder con éxito
    return {
      status: 200,
      jsonBody: result
    };
  } catch (error) {
    logger.error('Error al procesar la subida de documento:', error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('documentUpload', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'knowledge/documents/upload',
  handler: documentUpload
});