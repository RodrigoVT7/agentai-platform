// src/functions/integrations/GoogleCalendar.ts
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { GoogleCalendarHandler } from "../../shared/handlers/integrations/googleCalendarHandler";
import { GoogleCalendarValidator } from "../../shared/validators/integrations/googleCalendarValidator";
import { createLogger } from "../../shared/utils/logger";
import { toAppError } from "../../shared/utils/error.utils";
import { JwtService } from "../../shared/utils/jwt.service";

export async function GoogleCalendar(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const logger = createLogger(context);
  
  try {
    // Para callback de OAuth, permitir sin autenticación
    if (request.method === 'GET' && request.url.includes('/auth/callback')) {
      return handleGoogleAuthCallback(request, logger);
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
    const handler = new GoogleCalendarHandler(logger);
    const validator = new GoogleCalendarValidator(logger);
    
    // Manejar según el método HTTP y la acción
    switch (request.method) {
      case 'GET':
        if (action === 'auth') {
          // Generar URL de autorización de Google
          const agentId = request.query.get('agentId');
          if (!agentId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere agentId para autorización" }
            };
          }
          
          return await handler.getAuthUrl(agentId, userId);
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
        } else if (action === 'calendars') {
          // Listar calendarios disponibles
          if (!integrationId) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID de la integración" }
            };
          }
          
          return await handler.listCalendars(integrationId, userId);
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
          
          // Corregido: Verificar que eventData tiene la propiedad eventId antes de usarla
          if (!eventData || typeof eventData !== 'object' || !('eventId' in eventData)) {
            return {
              status: 400,
              jsonBody: { error: "Se requiere ID del evento (eventId)" }
            };
          }
          
          const eventId = eventData.eventId as string;
          
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
    logger.error("Error en integración de Google Calendar:", error);
    
    const appError = toAppError(error);
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

/**
 * Función auxiliar para manejar el callback de autorización de Google.
 * MODIFICADA PARA DEVOLVER JSON EN LUGAR DE REDIRECCIONES (Backend-Only).
 */
async function handleGoogleAuthCallback(request: HttpRequest, logger: any): Promise<HttpResponseInit> {
  try {
    // Obtener parámetros de la URL de callback
    const code = request.query.get('code');
    const state = request.query.get('state');
    const error = request.query.get('error'); // Error devuelto por Google

    // 1. Manejo de errores devueltos directamente por Google
    if (error) {
      logger.warn(`Error en callback de Google: ${error}`);
      // Devolver respuesta JSON de error
      return {
        status: 400, // Bad Request (o 401 Unauthorized, dependiendo del error)
        jsonBody: {
          success: false,
          message: "Autorización de Google fallida",
          error: error,
          details: request.query.get('error_description') || 'Google devolvió un error.'
        }
      };
    }

    // 2. Validar que 'code' y 'state' estén presentes
    if (!code || !state) {
      logger.warn(`Callback de Google incompleto: code=${code}, state=${state}`);
      return {
        status: 400, // Bad Request
        jsonBody: {
          success: false,
          error: "Callback de Google incompleto",
          message: "Faltan los parámetros 'code' o 'state' en la solicitud de callback."
         }
      };
    }

    // 3. Decodificar 'state'
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      const decodeError = e instanceof Error ? e.message : String(e);
      logger.error(`Error al decodificar state: ${decodeError}`);
      return {
        status: 400, // Bad Request
        jsonBody: {
          success: false,
          error: "State inválido",
          message: "El parámetro 'state' recibido no es válido o está corrupto.",
          details: decodeError
         }
      };
    }

    // 4. Validar contenido de 'state'
    const { userId, agentId } = stateData;
    if (!userId || !agentId) {
      logger.warn(`State inválido en callback: ${state}`);
      return {
        status: 400, // Bad Request
        jsonBody: {
          success: false,
          error: "State inválido",
          message: "El parámetro 'state' no contiene la información necesaria (userId, agentId)."
         }
      };
    }

    // 5. Procesar el código de autorización (intercambiar por tokens, guardar integración)
    // Se asume que GoogleCalendarHandler está disponible y configurado
    const handler = new GoogleCalendarHandler(logger);
    // processAuthCode debería devolver { integrationId: string } en caso de éxito o lanzar un error
    const result = await handler.processAuthCode(code, userId, agentId);

    // 6. Devolver respuesta JSON de éxito
    logger.info(`Integración Google Calendar ${result.integrationId} configurada exitosamente para agente ${agentId}`);
    return {
      status: 200, // OK
      jsonBody: {
        success: true,
        message: "Integración con Google Calendar configurada exitosamente.",
        integrationId: result.integrationId,
        agentId: agentId
      }
    };

  } catch (error: unknown) { // 7. Manejo de errores internos durante el procesamiento del callback
    logger.error("Error interno en callback de Google:", error);
    const appError = toAppError(error); // Convierte a tu formato de error estándar

    // Devolver respuesta JSON de error interno
    return {
      status: appError.statusCode || 500, // Internal Server Error (o el código del error si es específico)
      jsonBody: {
        success: false,
        message: "Error interno del servidor al procesar el callback de Google.",
        error: appError.message,
        details: appError.details // Incluye detalles adicionales si están disponibles
      }
    };
  }
}

// 1. Ruta para acciones generales de Google (sin ID específico)
app.http('GoogleCalendarGeneralActions', {
  methods: ['GET'], // O los métodos que necesites para acciones sin ID
  authLevel: 'anonymous',
  route: 'integrations/google/{action}', // {action} es ahora obligatorio aquí
  handler: GoogleCalendar // Sigue usando el mismo handler
});

// 2. Ruta para acciones sobre una integración específica (CON ID)
app.http('GoogleCalendarSpecificIntegration', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'], // Métodos para operar sobre una integración
  authLevel: 'anonymous',
  route: 'integrations/google/{id}/{action?}', // {id} es ahora obligatorio, {action} opcional
  handler: GoogleCalendar // Sigue usando el mismo handler
});

// 3. Ruta Específica para Callback de OAuth (sin cambios)
app.http('GoogleCalendarCallback', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'integrations/google/auth/callback',
  handler: GoogleCalendar
});