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
      // Pass the entire request to handleGoogleAuthCallback
      return handleGoogleAuthCallback(request, logger); // Asegúrate que handleGoogleAuthCallback esté definida o importada si es externa
    }
    
    // Para otras operaciones, verificar autenticación
    const authHeader = request.headers.get('authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return {
        status: 401,
        jsonBody: { error: "Se requiere autenticación" }
      };
    }
    
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
    
    // Este es el ID del usuario de la plataforma que está haciendo la llamada (dueño del token JWT)
    const userIdFromJwt = payload.userId;
    if (!userIdFromJwt) {
      return {
        status: 401,
        jsonBody: { error: "Token no contiene userId" }
      };
    }
    
    const integrationId = request.params.id;
    const action = request.params.action;
    
    const handler = new GoogleCalendarHandler(logger);
    const validator = new GoogleCalendarValidator(logger); // Asumiendo que existe y está importado
    
    // Obtener datos del cuerpo de la solicitud (si los hay, para POST/PUT)
    // Esto es importante para extraer el leadEmail si viene en el cuerpo
    let requestBody: any = {};
    if (request.method === 'POST' || request.method === 'PUT') {
        try {
            requestBody = await request.json();
        } catch (e) {
            // No hacer nada si no hay cuerpo o no es JSON,
            // las validaciones posteriores lo manejarán si es necesario
        }
    }

    // *** LÓGICA IMPORTANTE: Determinar el ID de usuario objetivo para la operación de calendario ***
    // Priorizar 'leadEmail' (o un campo similar) si viene en el cuerpo de la solicitud.
    // Este 'leadEmail' es el que Luna (el agente) debe haber obtenido del lead.
    // Si no, se usa el userId del usuario autenticado (JWT).
    const targetUserIdForCalendar = requestBody?.leadEmail || userIdFromJwt;

    if (!targetUserIdForCalendar) {
        return {
            status: 400,
            jsonBody: { error: "No se pudo determinar el usuario para la acción de calendario (falta leadEmail en el cuerpo para operaciones de lead, o el token JWT no tiene userId)." }
        };
    }
    
    logger.info(`Función GoogleCalendar: Acción '${action}' para integración '${integrationId}'. Target User/Lead: '${targetUserIdForCalendar}'. Solicitado por (JWT User): '${userIdFromJwt}'.`);

    switch (request.method) {
      case 'GET':
        if (action === 'auth') {
          const agentIdForAuth = request.query.get('agentId');
          if (!agentIdForAuth) {
            return { status: 400, jsonBody: { error: "Se requiere agentId para autorización" } };
          }
          // La autorización se inicia en nombre del usuario autenticado (userIdFromJwt) para un agentId
          return await handler.getAuthUrl(agentIdForAuth, userIdFromJwt);
        } else if (action === 'events') {
          if (!integrationId) {
            return { status: 400, jsonBody: { error: "Se requiere ID de la integración" } };
          }
          const startDate = request.query.get('start');
          const endDate = request.query.get('end');
          // Los eventos se obtienen para el targetUserIdForCalendar (que podría ser el leadEmail)
          return await handler.getEvents(integrationId, targetUserIdForCalendar, {
            startDate: startDate || undefined,
            endDate: endDate || undefined
          });
        } else if (action === 'calendars') {
          if (!integrationId) {
            return { status: 400, jsonBody: { error: "Se requiere ID de la integración" } };
          }
          // Listar calendarios generalmente es una acción del dueño de la integración (userIdFromJwt)
          return await handler.listCalendars(integrationId, userIdFromJwt);
        } else if (action === 'getMyBookedEvents') { // Asumiendo que esta acción se implementará o mapeará
            if (!integrationId) {
                return { status: 400, jsonBody: { error: "Se requiere ID de la integración para getMyBookedEvents" }};
            }
            const startDate = request.query.get('startDate'); // o como se llamen tus query params
            const endDate = request.query.get('endDate');
            // getMyBookedEvents debe usar targetUserIdForCalendar (que es el email del lead si se pasó)
            return await handler.getMyBookedEvents(integrationId, targetUserIdForCalendar, {
                startDate: startDate || undefined,
                endDate: endDate || undefined
            });
        } else if (integrationId) {
          // Obtener detalles de la integración, usualmente para el dueño (userIdFromJwt)
          return await handler.getIntegration(integrationId, userIdFromJwt);
        } else {
          return { status: 400, jsonBody: { error: "Acción GET no válida o falta ID de integración" } };
        }
      
      case 'POST':
        if (action === 'event') {
          if (!integrationId) {
            return { status: 400, jsonBody: { error: "Se requiere ID de la integración para crear evento" } };
          }
          // eventData ya se parseó como requestBody
          const validationResult = await validator.validateEvent(requestBody);
          if (!validationResult.isValid) {
            return { status: 400, jsonBody: { error: "Datos inválidos para el evento", details: validationResult.errors } };
          }
          // Crear evento para targetUserIdForCalendar (email del lead)
          return await handler.createEvent(integrationId, requestBody, targetUserIdForCalendar);
        } else {
          // Crear nueva integración, aquí userIdFromJwt es el creador/dueño
          const integrationValidation = await validator.validateIntegration(requestBody, userIdFromJwt);
          if (!integrationValidation.isValid) {
            return { status: 400, jsonBody: { error: "Datos inválidos para crear integración", details: integrationValidation.errors } };
          }
          return await handler.createIntegration(requestBody, userIdFromJwt);
        }
      
      case 'PUT':
        if (!integrationId) {
            return { status: 400, jsonBody: { error: "Se requiere ID de la integración para actualizar" } };
        }
        // eventData ya se parseó como requestBody
        if (action === 'event') {
          if (!requestBody?.eventId) { // eventId debe venir en el cuerpo para actualizar un evento específico
            return { status: 400, jsonBody: { error: "Se requiere ID del evento (eventId) en el cuerpo para actualizar" } };
          }
          const validationResult = await validator.validateEvent(requestBody); // Revalidar datos del evento
          if (!validationResult.isValid) {
            return { status: 400, jsonBody: { error: "Datos inválidos para el evento", details: validationResult.errors } };
          }
          // Actualizar evento para targetUserIdForCalendar (email del lead), usa requestBody.eventId
          return await handler.updateEvent(integrationId, requestBody.eventId, requestBody, targetUserIdForCalendar);
        } else {
          // Actualizar configuración de la integración, usualmente para el dueño (userIdFromJwt)
          const updateValidation = await validator.validateUpdate(requestBody);
          if (!updateValidation.isValid) {
            return { status: 400, jsonBody: { error: "Datos inválidos para actualizar integración", details: updateValidation.errors } };
          }
          return await handler.updateIntegration(integrationId, requestBody, userIdFromJwt);
        }
      
      case 'DELETE':
        if (!integrationId) {
            return { status: 400, jsonBody: { error: "Se requiere ID de la integración para eliminar" } };
        }
        if (action === 'event') {
          const eventIdToDelete = request.query.get('eventId'); // eventId para DELETE usualmente viene en query o params
          if (!eventIdToDelete) {
            return { status: 400, jsonBody: { error: "Se requiere ID del evento (eventId) en query params para eliminar" } };
          }
          // Eliminar evento para targetUserIdForCalendar (email del lead)
          // eventData (el cuerpo) podría contener `sendNotifications` para Google.
          return await handler.deleteEvent(integrationId, eventIdToDelete, targetUserIdForCalendar, requestBody);
        } else {
          // Desactivar/eliminar integración, usualmente para el dueño (userIdFromJwt)
          return await handler.deleteIntegration(integrationId, userIdFromJwt);
        }
      
      default:
        return { status: 405, jsonBody: { error: "Método no permitido" } };
    }
  } catch (error) {
    logger.error("Error en la función GoogleCalendar:", error);
    const appError = toAppError(error); // Asumiendo que tienes toAppError
    return {
      status: appError.statusCode,
      jsonBody: { error: appError.message, details: appError.details }
    };
  }
}

// Asegúrate que esta función esté definida o importada correctamente
// Esta es una función auxiliar que debe existir en tu archivo o ser importada.
async function handleGoogleAuthCallback(request: HttpRequest, logger: any): Promise<HttpResponseInit> {
  const handler = new GoogleCalendarHandler(logger); // Necesita su propia instancia
  try {
    const code = request.query.get('code');
    const state = request.query.get('state');
    const error = request.query.get('error');

    if (error) {
      logger.warn(`Error en callback de Google: ${error}`);
      // DEVOLVER JSON EN LUGAR DE REDIRECCIÓN SI ASÍ SE PREFIERE
      return { status: 400, jsonBody: { success: false, error: `Error de Google: ${error}`, details: request.query.get('error_description') }};
    }
    
    if (!code || !state) {
      logger.warn(`Callback de Google incompleto: code=${code}, state=${state}`);
      return { status: 400, jsonBody: { success: false, error: "Parámetros faltantes en callback de Google" }};
    }
    
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64').toString());
    } catch (e) {
      logger.error(`Error al decodificar state: ${e}`);
      return { status: 400, jsonBody: { success: false, error: "State inválido en callback" }};
    }
    
    const { userId, agentId } = stateData;
    if (!userId || !agentId) {
      logger.warn(`State inválido en callback (faltan userId o agentId): ${state}`);
      return { status: 400, jsonBody: { success: false, error: "State no contiene datos necesarios" }};
    }
    
    const result = await handler.processAuthCode(code, userId, agentId); // Este userId es el de la plataforma que inició el OAuth
    
    // Devolver JSON con el resultado de la integración
    return { status: 200, jsonBody: { success: true, message: "Autorización con Google completada.", integrationId: result.integrationId, agentId: agentId }};

  } catch (error) {
    logger.error("Error en handleGoogleAuthCallback:", error);
    const appError = toAppError(error);
    return { status: appError.statusCode || 500, jsonBody: { success: false, error: appError.message, details: appError.details }};
  }
}


// ----- Registros de las funciones HTTP (como los tenías) -----

// 1. Ruta para acciones generales de Google (sin ID específico de integración)
app.http('GoogleCalendarGeneralActions', {
  methods: ['GET'], // Solo GET para 'auth' que es la única acción sin {id} aquí
  authLevel: 'anonymous', // La autenticación se maneja manualmente con JWT
  route: 'integrations/google/{action}', // {action} es 'auth'
  handler: GoogleCalendar
});

// 2. Ruta para acciones sobre una integración específica (CON ID)
app.http('GoogleCalendarSpecificIntegration', {
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  authLevel: 'anonymous', // Auth manual
  route: 'integrations/google/{id}/{action?}', // {id} es integrationId, {action} es 'events', 'event', 'calendars'
  handler: GoogleCalendar
});

// 3. Ruta Específica para Callback de OAuth
app.http('GoogleCalendarCallback', {
  methods: ['GET'],
  authLevel: 'anonymous', // No requiere JWT, usa 'code' y 'state' de Google
  route: 'integrations/google/auth/callback', // Ruta explícita para el callback
  handler: GoogleCalendar // Reutiliza la función principal, que desviará a handleGoogleAuthCallback
});