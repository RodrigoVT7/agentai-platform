// src/functions/knowledge/DocumentSearch.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { DocumentSearchHandler } from "../../shared/handlers/knowledge/documentSearchHandler";
import { DocumentSearchValidator } from "../../shared/validators/knowledge/documentSearchValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function documentSearch(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    
    // Obtener parámetros para la búsqueda
    const searchParamsRaw = await request.json();
    
    // Verificar que searchParams es un objeto para type safety
    if (typeof searchParamsRaw !== 'object' || searchParamsRaw === null) {
      return {
        status: 400,
        jsonBody: { error: "El cuerpo de la solicitud debe ser un objeto JSON válido" }
      };
    }

    const searchParams = searchParamsRaw as Record<string, any>;
    
    // Obtener parámetros obligatorios
    const query = searchParams.query as string;
    const knowledgeBaseId = searchParams.knowledgeBaseId as string;
    const agentId = searchParams.agentId as string;
    
    // Obtener parámetros opcionales con valores predeterminados
    const limit = typeof searchParams.limit === 'number' ? searchParams.limit : 5;
    const threshold = typeof searchParams.threshold === 'number' ? searchParams.threshold : 0.7;
    const includeContent = searchParams.includeContent !== undefined 
      ? Boolean(searchParams.includeContent) 
      : true;
    
    // Validar parámetros de entrada
    const validator = new DocumentSearchValidator(logger);
    const validationResult = validator.validate({ 
      query, 
      knowledgeBaseId, 
      agentId, 
      limit, 
      threshold, 
      includeContent 
    });
    
    if (!validationResult.isValid) {
      return {
        status: 400,
        jsonBody: { error: "Parámetros inválidos", details: validationResult.errors }
      };
    }
    
    // Verificar si el usuario tiene acceso al agente
    const hasAccess = await validator.validateAgentAccess(userId, agentId);
    
    if (!hasAccess) {
      return {
        status: 403,
        jsonBody: { error: "No tienes permiso para acceder a este agente" }
      };
    }
    
    // Crear manejador de búsqueda
    const handler = new DocumentSearchHandler(logger);
    
    // Ejecutar búsqueda
    const searchResults = await handler.execute({
      query,
      knowledgeBaseId,
      agentId,
      limit,
      threshold,
      includeContent
    });
    
    // Devolver resultados
    return {
      status: 200,
      jsonBody: searchResults
    };
  } catch (error) {
    logger.error('Error en búsqueda de documentos:', error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

app.http('documentSearch', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'knowledge/search',
  handler: documentSearch
});