// src/functions/integrations/MicrosoftGraph.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { MicrosoftGraphHandler } from "../../shared/handlers/integrations/microsoftGraphHandler";
import { MicrosoftGraphValidator } from "../../shared/validators/integrations/microsoftGraphValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function MicrosoftGraph(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Para callback de OAuth, permitir sin autenticación
    if (request.method === 'GET' && request.url.includes('/auth/callback')) {
      return handleMicrosoftAuthCallback(request, logger);
    }
    
    // Para otras operaciones, verificar autenticación
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
    
    // Crear handler y validator
    const handler = new MicrosoftGraphHandler(logger);
    const validator = new MicrosoftGraphValidator(logger);
    
    // Manejar según el método HTTP y la acción
    switch (request.method) {
      case 'GET':
        if (action === 'auth') {
          // Generar URL de autorización de Microsoft
          const agentId = request.query.get('agentId');
          if (!agentId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere agentId para autorización" }
            };
          }
          
          const scopes = request.query.get('scopes') || 'Calendars.Read,Calendars.ReadWrite,Mail.Read';
          return await handler.getAuthUrl(agentId, userId, scopes);
        } else if (action === 'events') {
          // Obtener eventos del calendario
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const startDate = request.query.get('start');
          const endDate = request.query.get('end');
          
          return await handler.getEvents(integrationId, userId, {
            startDate: startDate || undefined,
            endDate: endDate || undefined
          });
        } else if (action === 'mail') {
          // Obtener emails
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const folder = request.query.get('folder') || 'inbox';
          const limit = parseInt(request.query.get('limit') || '10');
          
          return await handler.getMail(integrationId, userId, {
            folder,
            limit
          });
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
        if (action === 'event') {
          // Crear nuevo evento
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const eventData = await request.json();
          
          // Validar datos del evento
          const eventValidation = await validator.validateEvent(eventData);
          if (!eventValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: eventValidation.errors }
            };
          }
          
          return await handler.createEvent(integrationId, eventData, userId);
        } else if (action === 'mail') {
          // Enviar email
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const mailData = await request.json();
          
          // Validar datos del email
          const mailValidation = await validator.validateMail(mailData);
          if (!mailValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: mailValidation.errors }
            };
          }
          
          return await handler.sendMail(integrationId, mailData, userId);
        } else {
          // Crear nueva integración (después de autorización)
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
        if (action === 'event') {
          // Actualizar evento existente
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const eventData = await request.json();
          const eventId = eventData.eventId;
          
          if (!eventId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID del evento" }
            };
          }
          
          // Validar datos del evento
          const eventValidation = await validator.validateEvent(eventData);
          if (!eventValidation.isValid) {
            return {
              status: 400,
              jsonBody: { error: "Datos inválidos", details: eventValidation.errors }
            };
          }
          
          return await handler.updateEvent(integrationId, eventId, eventData, userId);
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
        if (action === 'event') {
          // Eliminar evento
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          const eventId = request.query.get('eventId');
          if (!eventId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID del evento" }
            };
          }
          
          return await handler.deleteEvent(integrationId, eventId, userId);
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
    logger.error("Error en integración de Microsoft Graph:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

// Función para manejar callback de autorización de Microsoft
async function handleMicrosoftAuthCallback(request: HttpRequest, logger: any): Promise<HttpResponseInit> {
  try {
    // Obtener código de autorización
    const code = request.query.get('code');
    const state = request.query.get('state');
    const error = request.query.get('error');
    const errorDescription = request.query.get('error_description');
    
    if (error) {
      logger.warn(`Error en callback de Microsoft: ${error} - ${errorDescription}`);
      // Redirigir a frontend con error
      return {
        status: 302,
        headers: {
          "Location": `${process.env.FRONTEND_URL}/integrations/microsoft/error?error=${error}`
        }
      };
    }
    
    if (!code || !state) {
      logger.warn(`Callback de Microsoft incompleto: code=${code}, state=${state}`);
      return {
        status: 400,
        jsonBody: { error: "Parámetros faltantes en callback" }
      };
    }
    
    // Decodificar state (contiene userId y agentId)
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      logger.error(`Error al decodificar state: ${e}`);
      return {
        status: 400,
        jsonBody: { error: "State inválido" }
      };
    }
    
    const { userId, agentId } = stateData;
    
    if (!userId || !agentId) {
      logger.warn(`State inválido en callback: ${state}`);
      return {
        status: 400,
        jsonBody: { error: "State no contiene datos necesarios" }
      };
    }
    
    // Procesar código de autorización
    const handler = new MicrosoftGraphHandler(logger);
    const result = await handler.processAuthCode(code, userId, agentId);
    
    // Redirigir a frontend con resultado
    return {
      status: 302,
      headers: {
        "Location": `${process.env.FRONTEND_URL}/integrations/microsoft/success?integrationId=${result.integrationId}`
      }
    };
  } catch (error) {
    logger.error("Error en callback de Microsoft:", error);
    
    // Redirigir a frontend con error
    return {
      status: 302,
      headers: {
        "Location": `${process.env.FRONTEND_URL}/integrations/microsoft/error?error=server_error`
      }
    };
  }
}

app.http('MicrosoftGraph', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous',
  route: 'integrations/microsoft/{id?}/{action?}',
  handler: MicrosoftGraph
});

// Endpoint específico para callback de OAuth
app.http('MicrosoftGraphCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/microsoft/auth/callback',
  handler: MicrosoftGraph
});