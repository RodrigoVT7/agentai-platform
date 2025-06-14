// src/shared/handlers/integrations/googleCalendarHandler.ts

import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, GOOGLE_CALENDAR_CONFIG } from "../../constants"; 
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils";
import {
  Integration,
  IntegrationType,
  IntegrationStatus,
  IntegrationGoogleCalendarConfig
} from "../../models/integration.model";
import { RoleType } from "../../models/userRole.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";
// Asegúrate de importar calendar_v3 y GaxiosResponse si los usas directamente.
import { google, Auth, calendar_v3, Common } from "googleapis"; 
import { GaxiosResponse } from "gaxios"; // Necesario para tipar la respuesta de GAPI

export class GoogleCalendarHandler {
  private storageService: StorageService;
  private logger: Logger;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
    this.clientId = process.env.GOOGLE_CLIENT_ID || '';
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      this.logger.warn("Configuración de Google OAuth incompleta. Funciones de autorización podrían fallar.");
    }
  }

  async getAuthUrl(agentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const hasAccess = await this.verifyOwnerOrAdminAccess(agentId, userId); 
      if (!hasAccess) {
        return { status: 403, jsonBody: { error: "No tienes permiso para configurar esta integración para el agente." } };
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      const scopes = [
        'https://www.googleapis.com/auth/calendar', 
        'https://www.googleapis.com/auth/calendar.events' 
      ];
      const state = Buffer.from(JSON.stringify({ userId, agentId })).toString('base64');

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', 
        scope: scopes,
        state,
        prompt: 'consent' 
      });

      return { status: 200, jsonBody: { authUrl, message: "URL de autorización generada con éxito" } };
    } catch (error) {
      this.logger.error("Error al generar URL de autorización de Google:", error);
      const appError = toAppError(error); 
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }

  async processAuthCode(code: string, userId: string, agentId: string): Promise<any> {
    try {
      const hasAccess = await this.verifyOwnerOrAdminAccess(agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para completar la configuración de esta integración para el agente.");
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.access_token) {
        throw createAppError(400, "No se pudo obtener token de acceso de Google.");
      }
      if (!tokens.refresh_token) {
        this.logger.warn("No se recibió refresh_token de Google. El acceso podría expirar y requerir re-autenticación manual.");
      }

      oauth2Client.setCredentials(tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      const calendarResponse = await calendar.calendarList.list();
      const primaryCalendar = calendarResponse.data.items?.find(cal => cal.primary) || calendarResponse.data.items?.[0];

      if (!primaryCalendar?.id) {
          throw createAppError(400, "No se pudo determinar el calendario principal del usuario de Google.");
      }

      const integrationId = uuidv4();
      const now = Date.now();
      const config: IntegrationGoogleCalendarConfig = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '', 
        expiresAt: tokens.expiry_date || (Date.now() + 3599 * 1000), 
        scope: Array.isArray(tokens.scope) ? tokens.scope.join(' ') : tokens.scope || '',
        calendarId: primaryCalendar.id,
        timezone: primaryCalendar.timeZone || undefined,
        maxConcurrentAppointments: GOOGLE_CALENDAR_CONFIG.DEFAULT_MAX_CONCURRENT_APPOINTMENTS // Añadido desde constantes
      };

      const integration: Integration = {
        id: integrationId,
        agentId,
        name: `Google Calendar (${primaryCalendar.summary || primaryCalendar.id})`,
        description: `Integración con Google Calendar para el calendario: ${primaryCalendar.summary || primaryCalendar.id}`,
        type: IntegrationType.CALENDAR,
        provider: 'google',
        config: JSON.stringify(config), 
        credentials: config.refreshToken || config.accessToken, 
        status: IntegrationStatus.ACTIVE, 
        createdBy: userId,
        createdAt: now,
        isActive: true
      };

      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.createEntity({ partitionKey: agentId, rowKey: integrationId, ...integration });

      this.logger.info(`Integración Google Calendar ${integrationId} creada exitosamente para agente ${agentId} por usuario ${userId}.`);
      return { integrationId, success: true, message: "Integración con Google Calendar configurada exitosamente." };

    } catch (error) {
      this.logger.error("Error al procesar código de autorización de Google:", error);
      throw toAppError(error); 
    }
  }

  async getEvents(integrationId: string, userId: string, options: { startDate?: string, endDate?: string }): Promise<HttpResponseInit> {
    let config: IntegrationGoogleCalendarConfig | null = null;
    try {
      const integration = await this.fetchIntegration(integrationId);
      if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
      }
      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
        return { status: 400, jsonBody: { error: `La integración Google Calendar (${integration.name}) no está activa.` } };
      }
      config = integration.config as IntegrationGoogleCalendarConfig; 

      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) return { status: 401, jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error } };
        if (refreshResult.accessToken) config.accessToken = refreshResult.accessToken;
        if (refreshResult.expiresAt) config.expiresAt = refreshResult.expiresAt;
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      oauth2Client.setCredentials({ access_token: config.accessToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const timeMin = options.startDate ? new Date(options.startDate).toISOString() : new Date().toISOString();
      const timeMax = options.endDate ? new Date(options.endDate).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const eventsResponse = await calendar.events.list({
        calendarId: config.calendarId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime'
      });
      const events = eventsResponse.data.items || [];

      return {
        status: 200,
        jsonBody: {
          success: true, 
          message: `Se encontraron ${events.length} eventos.`, 
          result: { 
              integrationId,
              calendarId: config.calendarId,
              events: events.map(e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end })), 
              period: { start: timeMin, end: timeMax }
          }
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener eventos para integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
    }
  }

async createEvent(integrationId: string, eventData: any, actualInteractingUserId: string): Promise<HttpResponseInit> {
    let integration: Integration | null = null;
    let config: IntegrationGoogleCalendarConfig | null = null;

    // Este es el ID del usuario de WhatsApp (o de otro canal) que está hablando con el bot.
    // Se usará para la clave WHATSAPP_NUMBER_KEY para que getMyBookedEvents funcione correctamente para ESTE usuario.
    const normalizedWhatsAppNumberForStorage = this.normalizeWhatsAppNumber(actualInteractingUserId); //
    this.logger.info(`[${integrationId}] Iniciando createEvent. Usuario real (para WHATSAPP_NUMBER_KEY): ${actualInteractingUserId} (Normalizado: ${normalizedWhatsAppNumberForStorage}). Datos del evento proporcionados por LLM: ${JSON.stringify(eventData)}`);

    try {
      integration = await this.fetchIntegration(integrationId); //
      if (!integration) {
        return { status: 404, jsonBody: { success: false, error: "Integración no encontrada." } };
      }
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') { //
        return { status: 400, jsonBody: { success: false, error: "La integración no es de Google Calendar." } };
      }
      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) { //
        return { status: 400, jsonBody: { success: false, error: `La integración Google Calendar (${integration.name}) no está activa.` } };
      }
      
      config = integration.config as IntegrationGoogleCalendarConfig; //
      const maxConcurrent = config.maxConcurrentAppointments ?? GOOGLE_CALENDAR_CONFIG.DEFAULT_MAX_CONCURRENT_APPOINTMENTS; //

      if (config.expiresAt < Date.now()) { //
        const refreshResult = await this.refreshToken(integration); //
        if (!refreshResult.success || !refreshResult.accessToken || !refreshResult.expiresAt) {
          return { status: 401, jsonBody: { success: false, error: "Error al actualizar token de acceso.", details: refreshResult.error } };
        }
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }

      // Extraer detalles del evento que el LLM puso en 'eventData' (originalmente 'parameters' del tool call)
      const userProvidedEmail = eventData.userEmail; // Email que el usuario dijo en la conversación
      const userProvidedName = eventData.userName;   // Nombre que el usuario dijo en la conversación
      
      if (!userProvidedEmail) {
        return { status: 400, jsonBody: { success: false, error: "Se requiere el campo 'userEmail' en eventData (parámetros de la herramienta)." } };
      }
      if (!GOOGLE_CALENDAR_CONFIG.EMAIL_VALIDATION_REGEX.test(userProvidedEmail)) { //
        return { status: 400, jsonBody: { success: false, error: `Email inválido en eventData: ${userProvidedEmail}` } };
      }
      // El nombre es importante para la experiencia, pero podría ser opcional si el LLM no siempre lo obtiene.
      if (!userProvidedName) {
          this.logger.warn(`[${integrationId}] El campo 'userName' no fue proporcionado en eventData para createEvent. Se usará el email o un nombre genérico.`);
      }

      let { 
          summary, 
          start, 
          end, 
          location, 
          description, 
          attendees, // El LLM podría sugerir otros asistentes
          reminders,
          addConferenceCall = false, 
          sendNotifications = 'default' 
      } = eventData;

   
      // Construir el título y descripción del evento
      summary = this.buildEventTitle(summary, userProvidedName || userProvidedEmail); //
      description = this.buildEventDescription(description, userProvidedName || userProvidedEmail, actualInteractingUserId); //

      if (!start || (!start.dateTime && !start.date)) throw createAppError(400, "Falta fecha/hora de inicio válida (start) en eventData."); //
      
      const eventTimeZone = start.timeZone || config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; //
      if (start.dateTime && !start.timeZone) start.timeZone = eventTimeZone;

      if (!end && start.dateTime) { //
        try {
          const startDateObj = new Date(start.dateTime);
          const durationMinutes = GOOGLE_CALENDAR_CONFIG.DEFAULT_APPOINTMENT_DURATION_MINUTES; //
          const endDateObj = new Date(startDateObj.getTime() + durationMinutes * 60000);
          end = { dateTime: endDateObj.toISOString(), timeZone: start.timeZone };
          this.logger.info(`Hora de fin calculada: ${end.dateTime} (${end.timeZone})`); //
        } catch (dateError) { 
          throw createAppError(400, `Formato de start.dateTime inválido: ${start.dateTime}`); //
        }
      } else if (!end && start.date) {  //
        try {
          const startDateObj = new Date(start.date + 'T00:00:00Z'); 
          const endDateObj = new Date(startDateObj.getTime() + 24 * 60 * 60 * 1000);
          end = { date: endDateObj.toISOString().split('T')[0] };
          this.logger.info(`Fecha de fin calculada para evento de día completo: ${end.date}`); //
        } catch (dateError) { 
          throw createAppError(400, `Formato de start.date inválido: ${start.date}`); //
        }
      }
      
      if (!end || (!end.dateTime && !end.date)) throw createAppError(400, "Falta fecha/hora de fin (end) en eventData y no se pudo calcular."); //
      if (end.dateTime && !end.timeZone) end.timeZone = start.timeZone || eventTimeZone; 

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri); //
      oauth2Client.setCredentials({ access_token: config.accessToken, refresh_token: config.refreshToken }); //
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client }); //

      // Verificar si el usuario (actualInteractingUserId) ya tiene una cita activa
      this.logger.info(`[${integration.id}] Verificando si el usuario ${actualInteractingUserId} ya tiene citas activas.`); //
      const userEventsCheck = await this.getMyBookedEvents(integrationId, actualInteractingUserId, { //
          startDate: new Date().toISOString(),
          endDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
      });

      if (userEventsCheck.status === 200 && userEventsCheck.jsonBody?.result?.events?.length > 0) {
          const activeEvents = userEventsCheck.jsonBody.result.events.filter((event: any) => {
              const eventEndTime = event.end?.dateTime || event.end?.date;
              return eventEndTime && (new Date(eventEndTime) > new Date());
          });
       
       if (activeEvents.length > 0) {
           const existingEvent = activeEvents[0];
           this.logger.warn(`[${integration.id}] Usuario ya tiene ${activeEvents.length} cita(s) activa(s).`);
           return {
               status: 409,
               jsonBody: {
                   success: false,
                   error: "Cita duplicada",
                   message: `Ya tienes una cita programada para el ${existingEvent.start?.dateTime || existingEvent.start?.date} (${existingEvent.summary}). Solo puedes tener una cita activa a la vez. ¿Te gustaría reagendarla?`,
                   details: {
                       existingAppointment: existingEvent,
                       userAlreadyHasAppointment: true
                   }
               }
           };
       }
   }

   // Verificación de concurrencia general del slot
   const checkTimeMin = start.dateTime || new Date(start.date + 'T00:00:00Z').toISOString(); 
   const checkTimeMax = end.dateTime || new Date(end.date + 'T23:59:59Z').toISOString(); 
   let existingEventsCount = 0;

   try {
     this.logger.info(`[${integration.id}] Verificando eventos en calendario '${config.calendarId}' entre ${checkTimeMin} y ${checkTimeMax}.`);
     const existingEventsResponse = await calendar.events.list({
       calendarId: config.calendarId, 
       timeMin: checkTimeMin, 
       timeMax: checkTimeMax, 
       singleEvents: true,
     });
     if (existingEventsResponse.data.items) {
       existingEventsCount = existingEventsResponse.data.items.length;
       this.logger.info(`[${integration.id}] Se encontraron ${existingEventsCount} eventos existentes en el horario.`);
     }
   } catch (listError: any) {
     this.logger.error(`[${integration.id}] Error al verificar eventos existentes:`, listError);
     return {
       status: 500,
       jsonBody: { 
         success: false, 
         error: "Error al verificar disponibilidad del calendario.", 
         details: listError.message 
       }
     };
   }

   if (existingEventsCount >= maxConcurrent) {
     this.logger.warn(`[${integration.id}] Conflicto de concurrencia. Eventos existentes: ${existingEventsCount}, Límite: ${maxConcurrent}.`);
     let conflictMessage = `El horario solicitado ya ha alcanzado el límite de ${maxConcurrent} cita(s) permitida(s).`;
     if (maxConcurrent === 1) {
       conflictMessage = `El horario solicitado ya está ocupado. Por favor, elige otro horario.`;
     }
     return {
       status: 409,
       jsonBody: { 
         success: false, 
         error: "Límite de citas alcanzado o slot no disponible", 
         message: conflictMessage, 
         details: { 
           existingEventsCount, 
           maxConcurrentAppointments: maxConcurrent, 
           requestedSlotUnavailable: true 
         }
       }
     };
   }
   
   this.logger.info(`[${integration.id}] Procediendo a crear evento. Usuario: ${userProvidedEmail}, WhatsApp: ${normalizedWhatsAppNumberForStorage }`);
   
 
const eventRequestBody: calendar_v3.Schema$Event = {
        summary: summary,
        location: typeof location === 'string' ? location : (location?.displayName || undefined),
        description: description,
        start: start as calendar_v3.Schema$EventDateTime, //
        end: end as calendar_v3.Schema$EventDateTime, //
        attendees: [ // El asistente principal es el email y nombre que el usuario proporcionó
            { email: userProvidedEmail, displayName: userProvidedName || userProvidedEmail },
            ...(attendees && Array.isArray(attendees) ? attendees.map((att: any) => ({ email: att.email })) : [])
        ],
        reminders: reminders || { useDefault: true }, //
        extendedProperties: {
            private: { //
                [GOOGLE_CALENDAR_CONFIG.BOOKED_BY_USER_ID_KEY]: userProvidedEmail, // Email que el usuario dijo, para referencia
                [GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY]: normalizedWhatsAppNumberForStorage, // **CLAVE: ID de WhatsApp normalizado del usuario que interactúa**
                [GOOGLE_CALENDAR_CONFIG.WHATSAPP_EMAIL_KEY]: userProvidedEmail, // Email que el usuario dijo
                [GOOGLE_CALENDAR_CONFIG.WHATSAPP_NAME_KEY]: userProvidedName || '',   // Nombre que el usuario dijo
                [GOOGLE_CALENDAR_CONFIG.WHATSAPP_AGENT_KEY]: integration.agentId, //
                whatsappBookingTime: Date.now().toString(), //
                whatsappOriginalNumber: actualInteractingUserId.replace(/^whatsapp:/i, '') // ID de WhatsApp original (sin prefijo)
            }
        }
      };
   
   let determinedSendUpdates: "all" | "externalOnly" | "none" | undefined = undefined;
   if (addConferenceCall) {
     eventRequestBody.conferenceData = {
       createRequest: {
         requestId: uuidv4(), 
         conferenceSolutionKey: { type: "hangoutsMeet" }
       }
     };
     determinedSendUpdates = sendNotifications !== 'none' ? "all" : "none";
   } else if (sendNotifications !== 'default') {
     determinedSendUpdates = sendNotifications as "all" | "externalOnly" | "none";
   } else {
     determinedSendUpdates = "all"; // Enviar notificación al usuario por defecto
   }

  
      const responseGaxios: GaxiosResponse<calendar_v3.Schema$Event> = await calendar.events.insert({  //
        calendarId: config.calendarId, 
        requestBody: eventRequestBody,
        conferenceDataVersion: addConferenceCall ? 1 : 0, 
        sendUpdates: determinedSendUpdates 
      });
      
      const createdEvent = responseGaxios.data;
      this.logger.info(`Evento ${createdEvent.id} creado. Clave WHATSAPP_NUMBER_KEY: '${normalizedWhatsAppNumberForStorage}', Email de asistente principal: '${userProvidedEmail}'.`); //


   return {
     status: 201,
     jsonBody: {
       success: true, 
       message: "Evento creado con éxito.",
       result: { 
         id: createdEvent.id, 
         summary: createdEvent.summary, 
         htmlLink: createdEvent.htmlLink,       
         hangoutLink: createdEvent.hangoutLink,  
         start: createdEvent.start, 
         end: createdEvent.end, 
         created: createdEvent.created,
         conferenceData: createdEvent.conferenceData,
         attendees: createdEvent.attendees
       }
     }
   };
 } catch (error) {
   this.logger.error(`Error al crear evento para integración ${integrationId}:`, error);
   const appError = toAppError(error);
   const statusCode = (error as any).statusCode === 409 ? 409 : appError.statusCode;
   return { 
     status: statusCode, 
     jsonBody: { 
       success: false, 
       error: appError.message, 
       details: appError.details,
       requestedSlotUnavailable: (appError.details as any)?.requestedSlotUnavailable || false,
       userAlreadyHasAppointment: (appError.details as any)?.userAlreadyHasAppointment || false
     } 
   };
 }
}

// NUEVOS métodos helper para mejorar títulos y descripciones
private buildEventTitle(originalSummary: string | undefined, userName: string | undefined): string {
    // Si no hay summary original, crear uno
    if (!originalSummary || originalSummary.trim() === '') {
        if (userName && userName.trim() !== '') {
            return `Cita con ${userName.trim()}`;
        } else {
            return "Cita agendada vía WhatsApp";
        }
    }
    
    const summary = originalSummary.trim();
    
    // Si el título ya incluye el nombre, no duplicar
    if (userName && userName.trim() !== '' && !summary.toLowerCase().includes(userName.toLowerCase())) {
        return `${summary} - ${userName.trim()}`;
    }
    
    return summary;
}

  private buildEventDescription(originalDescription: string | undefined, userName: string | undefined, whatsappNumberInteracting: string): string { //
    let description = originalDescription || '';
    const contextInfo = [
        `Cita para: ${userName || 'Usuario WhatsApp'}`,
        `Agendada vía WhatsApp`,
        `Contacto WhatsApp: ${whatsappNumberInteracting.replace(/^whatsapp:/i, '')}`
    ];
    if (description) {
        description += '\n\n---\n' + contextInfo.join('\n');
    } else {
        description = contextInfo.join('\n');
    }
    return description;
  }

async getMyBookedEvents(integrationId: string, requestingUserId: string, options: { startDate?: string, endDate?: string }): Promise<HttpResponseInit> {
  let integration: Integration | null = null;
  let config: IntegrationGoogleCalendarConfig | null = null;
  try {
    integration = await this.fetchIntegration(integrationId);
    if (!integration) return { status: 404, jsonBody: { success: false, error: "Integración no encontrada." } };
    if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
      return { status: 400, jsonBody: { success: false, error: "La integración no es de Google Calendar." } };
    }
    if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
      return { status: 400, jsonBody: { success: false, error: `La integración Google Calendar (${integration.name}) no está activa.` } };
    }
    config = integration.config as IntegrationGoogleCalendarConfig;
    
    if (config.expiresAt < Date.now()) {
      const refreshResult = await this.refreshToken(integration);
      if (!refreshResult.success || !refreshResult.accessToken || !refreshResult.expiresAt) {
        return { status: 401, jsonBody: { success: false, error: "Error al actualizar token de acceso.", details: refreshResult.error } };
      }
      config.accessToken = refreshResult.accessToken;
      config.expiresAt = refreshResult.expiresAt;
    }

    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
    oauth2Client.setCredentials({ access_token: config.accessToken, refresh_token: config.refreshToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const timeMin = options.startDate ? new Date(options.startDate).toISOString() : new Date().toISOString(); 
    const timeMax = options.endDate ? new Date(options.endDate).toISOString() : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); 

    // MEJORADO: Normalización consistente del número
    const normalizedSearchNumber = this.normalizeWhatsAppNumber(requestingUserId);
    this.logger.info(`[${integrationId}] Buscando eventos para WhatsApp normalizado: ${normalizedSearchNumber}`);
    
    let myBookedEvents: calendar_v3.Schema$Event[] = [];
    
    try {
      // Método simplificado: Obtener todos los eventos y filtrar por cliente
      const allEventsResponse = await calendar.events.list({
        calendarId: config.calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250
      });
      
      const allEvents = allEventsResponse.data.items || [];
      this.logger.info(`[${integrationId}] Total de eventos encontrados: ${allEvents.length}`);
      
      // Búsqueda por número de WhatsApp normalizado
      myBookedEvents = allEvents.filter(event => {
        const storedWhatsApp = event.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY];
        if (!storedWhatsApp) return false;
        
        const normalizedStoredNumber = this.normalizeWhatsAppNumber(storedWhatsApp);
        const isMatch = normalizedStoredNumber === normalizedSearchNumber;
        
        if (isMatch) {
          this.logger.info(`[${integrationId}] Match encontrado: "${event.summary}" (ID: ${event.id})`);
          this.logger.info(`[${integrationId}] Números: Guardado=${storedWhatsApp}, Normalizado guardado=${normalizedStoredNumber}, Buscado=${normalizedSearchNumber}`);
        }
        
        return isMatch;
      });
      
      // Log de resultados para depuración
      if (myBookedEvents.length > 0) {
        this.logger.info(`[${integrationId}] ✅ Se encontraron ${myBookedEvents.length} citas para ${normalizedSearchNumber}`);
      } else {
        this.logger.warn(`[${integrationId}] ⚠️ No se encontraron citas para ${normalizedSearchNumber}`);
        
        // Log adicional para depuración - mostrar algunos eventos para entender el problema
        this.logger.info(`[${integrationId}] DEBUG: Mostrando primeros 5 eventos y sus números WhatsApp:`);
        allEvents.slice(0, 5).forEach((event, i) => {
          const whatsappNumber = event.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY];
          const normalizedStored = whatsappNumber ? this.normalizeWhatsAppNumber(whatsappNumber) : 'No WhatsApp';
          this.logger.info(`[${integrationId}] Evento ${i+1}: "${event.summary}" - WhatsApp=${whatsappNumber}, Normalizado=${normalizedStored}`);
        });
      }
    } catch (searchError) {
      this.logger.error(`[${integrationId}] Error en búsqueda de eventos:`, searchError);
      throw searchError;
    }

    // Eliminar duplicados por ID
    const uniqueEvents = myBookedEvents.filter((event, index, self) => 
      index === self.findIndex(e => e.id === event.id)
    );

    // DEBUGGING: Log de eventos encontrados
    if (uniqueEvents.length > 0) {
      this.logger.info(`[${integrationId}] EVENTOS FINALES para ${normalizedSearchNumber}:`);
      uniqueEvents.forEach((event, index) => {
        const storedWhatsApp = event.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY];
        this.logger.info(`  ${index + 1}. "${event.summary}" (${event.start?.dateTime || event.start?.date}) - ID: ${event.id} - WhatsApp: ${storedWhatsApp}`);
      });
    }

    return {
      status: 200,
      jsonBody: {
        success: true,
        message: uniqueEvents.length > 0 
          ? `Encontré ${uniqueEvents.length} cita${uniqueEvents.length === 1 ? '' : 's'} agendada${uniqueEvents.length === 1 ? '' : 's'}.` 
          : "No tienes citas programadas actualmente.",
        result: {
          integrationId,
          calendarId: config.calendarId,
          whatsappNumber: normalizedSearchNumber,
          events: uniqueEvents.map((e: calendar_v3.Schema$Event) => ({
            id: e.id, 
            summary: e.summary || 'Sin título',
            start: e.start, 
            end: e.end, 
            location: e.location,
            description: e.description,
            htmlLink: e.htmlLink,
            hangoutLink: e.hangoutLink,
            whatsappInfo: {
              number: e.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY],
              email: e.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_EMAIL_KEY],
              name: e.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NAME_KEY]
            }
          })),
          period: { start: timeMin, end: timeMax }
        }
      }
    };
  } catch (error) {
    this.logger.error(`Error al obtener eventos para ${integrationId} y usuario ${requestingUserId}:`, error);
    const appError = toAppError(error);
    return { 
      status: appError.statusCode, 
      jsonBody: { 
        success: false, 
        error: appError.message, 
        details: appError.details 
      } 
    };
  }
}

// Método normalizeWhatsAppNumber mejorado
  private normalizeWhatsAppNumber(userId: string): string { //
    if (!userId) return '';
    let number = userId.replace(/^whatsapp:/i, ''); // Quita el prefijo "whatsapp:" si existe
    number = number.replace(/[^\d+]/g, '');
    if (!number.startsWith('+') && number.replace(/\D/g, '').length >= 10) {
        number = '+' + number;
    }
    number = number.replace(/\++/g, '+').replace(/(\+)(.+)\+/g, '$1$2');
    return number;
  }


// Método updateEvent completo con mejoras
 async updateEvent(integrationId: string, eventId: string, eventDataFromLlm: any, requestingUserId: string): Promise<HttpResponseInit> {
    let integration: Integration | null = null;
    let config: IntegrationGoogleCalendarConfig | null = null;
    this.logger.info(`[${integrationId}] Iniciando updateEvent para eventId: ${eventId}, solicitante: ${requestingUserId}, datos LLM: ${JSON.stringify(eventDataFromLlm)}`);

    try {
      integration = await this.fetchIntegration(integrationId);
      if (!integration) return { status: 404, jsonBody: { success: false, error: "Integración no encontrada." }};
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') return { status: 400, jsonBody: { success: false, error: "La integración no es de Google Calendar." }};
      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) return { status: 400, jsonBody: { success: false, error: `La integración Google Calendar (${integration.name}) no está activa.` }};
      
      config = integration.config as IntegrationGoogleCalendarConfig;
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success || !refreshResult.accessToken || !refreshResult.expiresAt) return { status: 401, jsonBody: { success: false, error: "Error al actualizar token de acceso.", details: refreshResult.error }};
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      oauth2Client.setCredentials({ access_token: config.accessToken, refresh_token: config.refreshToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      let existingEventFull: calendar_v3.Schema$Event;
      try {
        const getResponse = await calendar.events.get({ calendarId: config.calendarId, eventId });
        existingEventFull = getResponse.data;
        if (!existingEventFull) {
             this.logger.warn(`[${integrationId}] Evento ${eventId} no encontrado en Google Calendar para actualizar.`);
             return { status: 404, jsonBody: { success: false, error: "La cita que intentas modificar no fue encontrada en el calendario." }};
        }
        this.logger.info(`[${integrationId}] Evento existente ${eventId} obtenido. Título actual: "${existingEventFull.summary}"`);
      } catch (getError: any) {
        if (getError.code === 404) return { status: 404, jsonBody: { success: false, error: "La cita que intentas modificar no fue encontrada." }};
        this.logger.error(`Error obteniendo evento ${eventId} para actualizar:`, getError);
        throw createAppError(500, "Error al verificar la cita existente antes de actualizar.");
      }

      // Verificación de Permisos (usa el ID del usuario que está interactuando)
      const whatsappNumberInEvent = existingEventFull.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY];
      const normalizedRequestingWhatsAppNumber = this.normalizeWhatsAppNumber(requestingUserId);
      const normalizedEventNumber = whatsappNumberInEvent ? this.normalizeWhatsAppNumber(whatsappNumberInEvent) : null;
      const isAdminAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, requestingUserId); // Necesitas este método
      const isOwner = normalizedEventNumber === normalizedRequestingWhatsAppNumber;

      this.logger.info(`[${integrationId}] Permiso update. Solicitante (norm): ${normalizedRequestingWhatsAppNumber}, Dueño evento (norm): ${normalizedEventNumber}, Admin?: ${isAdminAccess}`);
      if (!isOwner && !isAdminAccess) {
          this.logger.warn(`[${integrationId}] Acceso DENEGADO para update: Usuario ${requestingUserId} vs Evento de ${whatsappNumberInEvent}.`);
          return { status: 403, jsonBody: { success: false, error: "No tienes permiso para modificar esta cita." }};
      }
      
      // Lógica de restricciones de agente (ej. no agendar el mismo día) si es aplicable
      // if (eventDataFromLlm.start && (eventDataFromLlm.start.dateTime || eventDataFromLlm.start.date)) { /* ... tu lógica de restricciones ... */ }


      // **INICIO DE LA CORRECCIÓN PRINCIPAL: Construir el cuerpo de la actualización**
      // Comenzamos con un objeto vacío y solo añadimos lo que el LLM quiere cambiar.
      // Google Calendar API usa PATCH semantics para `update`, por lo que solo los campos que envíes se modificarán.
      // Sin embargo, para sub-objetos como `start`, `end`, `extendedProperties.private`, si los envías, se reemplazan completos.
      // Por lo tanto, es mejor obtener el evento completo y modificarlo.

      const updatePayload: calendar_v3.Schema$Event = { ...existingEventFull }; // Clonar el evento existente

      let changesApplied = false;

      // Aplicar cambios de fecha/hora si vienen del LLM
      if (eventDataFromLlm.start && eventDataFromLlm.start.dateTime) {
        updatePayload.start = { 
            dateTime: eventDataFromLlm.start.dateTime, 
            timeZone: eventDataFromLlm.start.timeZone || existingEventFull.start?.timeZone || config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone 
        };
        changesApplied = true;
      } else if (eventDataFromLlm.start && eventDataFromLlm.start.date) { // Eventos de día completo
        updatePayload.start = { 
            date: eventDataFromLlm.start.date 
        };
        changesApplied = true;
      }

      if (eventDataFromLlm.end && eventDataFromLlm.end.dateTime) {
        updatePayload.end = { 
            dateTime: eventDataFromLlm.end.dateTime, 
            timeZone: eventDataFromLlm.end.timeZone || existingEventFull.end?.timeZone || updatePayload.start?.timeZone
        };
        changesApplied = true;
      } else if (eventDataFromLlm.end && eventDataFromLlm.end.date) { // Eventos de día completo
         updatePayload.end = { 
            date: eventDataFromLlm.end.date 
        };
        changesApplied = true;
      } else if (changesApplied && updatePayload.start?.dateTime && existingEventFull.start?.dateTime && existingEventFull.end?.dateTime) {
        // Si solo cambió el inicio, recalcular el fin para mantener la duración original
        const startMs = new Date(updatePayload.start.dateTime).getTime();
        const originalStartMs = new Date(existingEventFull.start.dateTime).getTime();
        const originalEndMs = new Date(existingEventFull.end.dateTime).getTime();
        const durationMs = originalEndMs - originalStartMs;
        updatePayload.end = { 
            dateTime: new Date(startMs + durationMs).toISOString(), 
            timeZone: updatePayload.start.timeZone 
        };
        this.logger.info(`[${integrationId}] Fin recalculado para mantener duración: ${updatePayload.end.dateTime}`);
      }
      
      // Actualizar otros campos solo si el LLM los provee explícitamente
      if (eventDataFromLlm.summary !== undefined) {
        updatePayload.summary = this.buildEventTitle(eventDataFromLlm.summary, eventDataFromLlm.userName || existingEventFull.attendees?.[0]?.displayName);
        if (updatePayload.summary !== existingEventFull.summary) changesApplied = true;
      }
      if (eventDataFromLlm.description !== undefined) {
        updatePayload.description = eventDataFromLlm.description;
         if (updatePayload.description !== existingEventFull.description) changesApplied = true;
      }
      if (eventDataFromLlm.location !== undefined) {
        updatePayload.location = typeof eventDataFromLlm.location === 'string' ? eventDataFromLlm.location : eventDataFromLlm.location?.displayName;
        if (updatePayload.location !== existingEventFull.location) changesApplied = true;
      }
      
      // Manejo de asistentes (ejemplo: reemplazar si se proveen, de lo contrario mantener existentes)
      if (eventDataFromLlm.attendees && Array.isArray(eventDataFromLlm.attendees)) {
        updatePayload.attendees = eventDataFromLlm.attendees.map((att: any) => ({ email: att.email, displayName: att.displayName }));
        // Aquí necesitarías una comparación más profunda para `changesApplied` si importa
        changesApplied = true; 
      }

      // Actualizar metadatos de la reserva (quién modificó, cuándo)
      updatePayload.extendedProperties = updatePayload.extendedProperties || { private: {} };
      updatePayload.extendedProperties.private = {
          ...(updatePayload.extendedProperties.private || {}),
          [GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY]: normalizedEventNumber || normalizedRequestingWhatsAppNumber, // Asegurar que se mantiene o actualiza correctamente
          lastModifiedByAgentInteraction: requestingUserId, // Quién está interactuando
          lastModifiedTimestamp: Date.now().toString()
      };
      // Si se cambian los extendedProperties, marcar como cambio
      if (JSON.stringify(updatePayload.extendedProperties.private) !== JSON.stringify(existingEventFull.extendedProperties?.private)) {
          changesApplied = true;
      }


      // Si no hubo cambios significativos detectados por el LLM
      if (!changesApplied && eventDataFromLlm.addConferenceCall === undefined) { // addConferenceCall también es un cambio
        this.logger.info(`[${integrationId}] No se detectaron cambios solicitados por el LLM para el evento ${eventId}. Devolviendo evento existente.`);
        return { 
          status: 200, 
          jsonBody: { 
            success: true, 
            message: "No se especificaron cambios para el evento.", 
            result: { 
              id: existingEventFull.id, 
              summary: existingEventFull.summary, 
              htmlLink: existingEventFull.htmlLink, 
              hangoutLink: existingEventFull.hangoutLink,
              updated: existingEventFull.updated, // Debería ser el 'updated' del evento existente
              start: existingEventFull.start,
              end: existingEventFull.end,
              attendees: existingEventFull.attendees,
              conferenceData: existingEventFull.conferenceData 
            } 
          }
        };
      }
      
      let conferenceDataModified = false;
      if (eventDataFromLlm.addConferenceCall !== undefined) { /* ... tu lógica de conferenceData ... */ }
      
      const sendUpdatesOption = eventDataFromLlm.sendNotifications || "all";

      this.logger.info(`[${integrationId}] Aplicando actualización al evento ${eventId} con payload: ${JSON.stringify(updatePayload).substring(0, 1000)}...`);

      const responseGaxios: GaxiosResponse<calendar_v3.Schema$Event> = await calendar.events.update({ 
        calendarId: config.calendarId, 
        eventId, 
        requestBody: updatePayload, // Enviar el objeto completo modificado
        conferenceDataVersion: conferenceDataModified ? 1 : 0, 
        sendUpdates: sendUpdatesOption
      });
      
      const updatedEvent = responseGaxios.data;
      this.logger.info(`Evento ${updatedEvent.id} actualizado exitosamente. Nuevo título: "${updatedEvent.summary}", Nueva hora inicio: ${updatedEvent.start?.dateTime || updatedEvent.start?.date}`);

      return {
        status: 200,
        jsonBody: {
          success: true, 
          message: "Evento actualizado con éxito.",
          result: { 
            id: updatedEvent.id, 
            summary: updatedEvent.summary, 
            htmlLink: updatedEvent.htmlLink, 
            hangoutLink: updatedEvent.hangoutLink,
            updated: updatedEvent.updated,
            start: updatedEvent.start,
            end: updatedEvent.end,
            attendees: updatedEvent.attendees,
            conferenceData: updatedEvent.conferenceData
          }
        }
      };
    } catch (error:any) {
      this.logger.error(`Error al actualizar evento ${eventId} para integración ${integrationId}:`, error);
      if (error.code === 412) { // ETag mismatch / concurrent modification
        this.logger.warn(`Fallo al actualizar evento ${eventId} debido a ETag mismatch (modificación concurrente).`);
        return { 
          status: 412, 
          jsonBody: { success: false, error: "La cita fue modificada por otra persona u otro proceso mientras intentabas guardarla. Por favor, revisa los detalles de la cita actual y vuelve a intentarlo si es necesario." } 
        };
      }
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
    }
  }

// Método auxiliar para obtener configuración específica del agente
private async getAgentConfig(agentId: string): Promise<any> {
  try {
    const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
    const agent = await tableClient.getEntity('agent', agentId);
    
    // Intentar parsear la configuración específica de calendario si existe
    let calendarSettings = {};
    
    if (typeof agent.calendarSettings === 'string' && agent.calendarSettings) {
      try {
        calendarSettings = JSON.parse(agent.calendarSettings);
      } catch (e) {
        this.logger.warn(`Error parseando calendarSettings para agente ${agentId}:`, e);
      }
    } else if (typeof agent.calendarSettings === 'object' && agent.calendarSettings !== null) {
      calendarSettings = agent.calendarSettings;
    }
    
    return {
      id: agent.rowKey,
      calendarSettings
    };
  } catch (error) {
    this.logger.error(`Error al obtener configuración del agente ${agentId}:`, error);
    return null;
  }
}


async deleteEvent(integrationId: string, eventId: string, requestingUserId: string, eventData: any = {}): Promise<HttpResponseInit> {
  let integration: Integration | null = null;
  let config: IntegrationGoogleCalendarConfig | null = null;
  
  this.logger.info(`🗑️ [Delete] Iniciando eliminación del evento ${eventId} por usuario ${requestingUserId}`);
  
  try {
    integration = await this.fetchIntegration(integrationId);
    if (!integration) return { status: 404, jsonBody: { success: false, error: "Integración no encontrada." }};
    if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') return { status: 400, jsonBody: { success: false, error: "La integración no es de Google Calendar." }};
    if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) return { status: 400, jsonBody: { success: false, error: `La integración Google Calendar (${integration.name}) no está activa.` }};
    
    config = integration.config as IntegrationGoogleCalendarConfig;
    if (config.expiresAt < Date.now()) {
      const refreshResult = await this.refreshToken(integration);
      if (!refreshResult.success || !refreshResult.accessToken || !refreshResult.expiresAt) return { status: 401, jsonBody: { success: false, error: "Error al actualizar token de acceso.", details: refreshResult.error }};
      config.accessToken = refreshResult.accessToken;
      config.expiresAt = refreshResult.expiresAt;
    }

    const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
    oauth2Client.setCredentials({ access_token: config.accessToken, refresh_token: config.refreshToken });
    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    // 🔥 AÑADIR: VERIFICACIÓN PREVIA DEL EVENTO
    let existingEvent: calendar_v3.Schema$Event | null = null;
    try {
      this.logger.info(`🔍 [Delete] Verificando existencia del evento ${eventId}`);
      const getResponse: GaxiosResponse<calendar_v3.Schema$Event> = await calendar.events.get({ 
        calendarId: config.calendarId, 
        eventId 
      });
      existingEvent = getResponse.data;
      this.logger.info(`✅ [Delete] Evento encontrado: "${existingEvent.summary}"`);
      
    } catch (getError: any) {
      // 🔥 MANEJAR ERRORES AL OBTENER EL EVENTO
      if (getError.code === 404 || getError.status === 404) {
        this.logger.warn(`⚠️ [Delete] Evento ${eventId} no encontrado (404) - considerando como eliminado`);
        return { 
          status: 200, 
          jsonBody: { 
            success: true, 
            message: "La cita ya había sido eliminada o no existía.", 
            result: { id: eventId, status: 'not_found' }
          }
        };
      }
      
      if (getError.code === 410 || getError.status === 410) {
        this.logger.warn(`⚠️ [Delete] Evento ${eventId} ya fue eliminado previamente (410)`);
        return { 
          status: 200, 
          jsonBody: { 
            success: true, 
            message: "La cita ya había sido eliminada previamente.", 
            result: { id: eventId, status: 'already_deleted' }
          }
        };
      }
      
      this.logger.error(`❌ [Delete] Error obteniendo evento ${eventId}:`, getError);
      throw createAppError(500, "Error al verificar la cita antes de eliminar");
    }

    // VERIFICACIÓN DE PERMISOS (código existente pero mejorado)
    const normalizedRequestingNumber = this.normalizeWhatsAppNumber(requestingUserId);
    const whatsappNumberInEvent = existingEvent?.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY];
    const normalizedEventNumber = whatsappNumberInEvent ? this.normalizeWhatsAppNumber(whatsappNumberInEvent) : null;
    
    const isAdminAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, requestingUserId);
    const isOwner = normalizedEventNumber === normalizedRequestingNumber;

    this.logger.info(`🔐 [Delete] Permisos - Solicitante: ${normalizedRequestingNumber}, Dueño: ${normalizedEventNumber}, Admin: ${isAdminAccess}`);

    if (!isOwner && !isAdminAccess) {
      this.logger.warn(`🚫 [Delete] Acceso DENEGADO para eliminar evento ${eventId}`);
      return { 
        status: 403, 
        jsonBody: { 
          success: false, 
          error: "No tienes permiso para eliminar esta cita porque fue agendada por otro usuario." 
        }
      };
    }

    // CONFIGURAR NOTIFICACIONES
    const sendCancelNotificationsOption = eventData.sendNotifications || 'default';
    let sendUpdatesValue: "all" | "none" | "externalOnly" = "all"; 
    if (sendCancelNotificationsOption === 'none') {
      sendUpdatesValue = "none";
    } else if (sendCancelNotificationsOption === 'externalOnly') {
      sendUpdatesValue = "externalOnly";
    }
    
    // 🔥 EJECUTAR ELIMINACIÓN CON MANEJO MEJORADO DE ERRORES
    try {
      this.logger.info(`🗑️ [Delete] Procediendo a eliminar evento ${eventId}`);
      
      await calendar.events.delete({ 
        calendarId: config.calendarId, 
        eventId,
        sendUpdates: sendUpdatesValue 
      });
      
      this.logger.info(`✅ [Delete] Evento ${eventId} eliminado exitosamente`);

      return {
        status: 200,
        jsonBody: { 
          success: true, 
          message: "Cita eliminada con éxito.", 
          result: { 
            id: eventId, 
            status: 'deleted',
            deletedBy: requestingUserId,
            timestamp: new Date().toISOString()
          }
        }
      };
      
    } catch (deleteError: any) {
      // 🔥 MANEJO ESPECÍFICO DE ERRORES DE ELIMINACIÓN
      if (deleteError.code === 410 || deleteError.status === 410) {
        this.logger.warn(`⚠️ [Delete] Evento ${eventId} ya estaba eliminado (410 en delete)`);
        return {
          status: 200,
          jsonBody: { 
            success: true, 
            message: "La cita ya había sido eliminada previamente.", 
            result: { id: eventId, status: 'already_deleted' }
          }
        };
      }
      
      if (deleteError.code === 404 || deleteError.status === 404) {
        this.logger.warn(`⚠️ [Delete] Evento ${eventId} no encontrado durante eliminación (404)`);
        return {
          status: 200,
          jsonBody: { 
            success: true, 
            message: "La cita ya no existe en el calendario.", 
            result: { id: eventId, status: 'not_found_on_delete' }
          }
        };
      }
      
      if (deleteError.code === 403 || deleteError.status === 403) {
        this.logger.error(`🚫 [Delete] Sin permisos para eliminar evento ${eventId}`);
        return {
          status: 403,
          jsonBody: { 
            success: false, 
            error: "Sin permisos suficientes para eliminar esta cita en Google Calendar."
          }
        };
      }
      
      // Error genérico
      this.logger.error(`❌ [Delete] Error eliminando evento ${eventId}:`, deleteError);
      throw deleteError;
    }

  } catch (error: any) {
    this.logger.error(`💥 [Delete] Error fatal eliminando evento ${eventId}:`, error);
    const appError = toAppError(error);
    return { 
      status: appError.statusCode, 
      jsonBody: { 
        success: false, 
        error: appError.message, 
        details: appError.details
      } 
    };
  }
}
  
  async listCalendars(integrationId: string, userId: string): Promise<HttpResponseInit> {
    let config: IntegrationGoogleCalendarConfig | null = null;
    try {
        const integration = await this.fetchIntegration(integrationId);
        if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
        const hasAdminAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, userId);
        if (!hasAdminAccess) return { status: 403, jsonBody: { error: "No tienes permiso para listar los calendarios de esta integración." } };
        
        if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
            return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
        }
        if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
            return { status: 400, jsonBody: { error: `La integración Google Calendar (${integration.name}) no está activa.` } };
        }
        config = integration.config as IntegrationGoogleCalendarConfig;

        if (config.expiresAt < Date.now()) {
            const refreshResult = await this.refreshToken(integration);
            if (!refreshResult.success || !refreshResult.accessToken || !refreshResult.expiresAt) return { status: 401, jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error } };
            config.accessToken = refreshResult.accessToken;
            config.expiresAt = refreshResult.expiresAt;
        }

        const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
        oauth2Client.setCredentials({ access_token: config.accessToken, refresh_token: config.refreshToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        const calendarResponse = await calendar.calendarList.list();
        const calendars = calendarResponse.data.items || [];

        const formattedCalendars = calendars.map(cal => ({
            id: cal.id, summary: cal.summary, description: cal.description,
            primary: cal.primary || false, accessRole: cal.accessRole, timeZone: cal.timeZone
        }));
        return {
            status: 200,
            jsonBody: {
                integrationId, calendars: formattedCalendars, currentCalendarId: config.calendarId
            }
        };
    } catch (error) {
        this.logger.error(`Error al obtener calendarios para integración ${integrationId}:`, error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }

  async getIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const integration = await this.fetchIntegration(integrationId);
      if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
      const hasAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, userId);
      if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para acceder a esta integración." } };

      const { credentials, config: rawConfig, ...safeIntegration } = integration;
      const config = rawConfig as IntegrationGoogleCalendarConfig; 

      const sanitizedConfig = {
        calendarId: config.calendarId, 
        scope: config.scope, 
        expiresAt: config.expiresAt,
        timezone: config.timezone,
        maxConcurrentAppointments: config.maxConcurrentAppointments,
        hasRefreshToken: !!config.refreshToken 
      };

      return { status: 200, jsonBody: { ...safeIntegration, config: sanitizedConfig } };
    } catch (error) {
      this.logger.error(`Error al obtener integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }

  async createIntegration(data: any, userId: string): Promise<HttpResponseInit> {
     try {
         const { agentId, name, description, accessToken, refreshToken, expiresAt, calendarId, scope, maxConcurrentAppointments } = data;

         const hasAccess = await this.verifyAccess(agentId, userId); 
         if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para modificar este agente" } };
         if (!accessToken) return { status: 400, jsonBody: { error: "Se requiere token de acceso" } };

         const integrationId = uuidv4();
         const now = Date.now();
         const config: IntegrationGoogleCalendarConfig = {
             accessToken, refreshToken: refreshToken || '', expiresAt: expiresAt || (now + 3600000),
             scope: scope || 'https://www.googleapis.com/auth/calendar', calendarId: calendarId || 'primary',
             maxConcurrentAppointments: maxConcurrentAppointments ?? GOOGLE_CALENDAR_CONFIG.DEFAULT_MAX_CONCURRENT_APPOINTMENTS
         };
         const integration: Integration = {
             id: integrationId, agentId, name: name || "Google Calendar",
             description: description || "Integración con Google Calendar", type: IntegrationType.CALENDAR,
             provider: 'google', config: JSON.stringify(config), credentials: refreshToken || accessToken,
             status: IntegrationStatus.ACTIVE, createdBy: userId, createdAt: now, isActive: true
         };

         const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
         await tableClient.createEntity({ partitionKey: agentId, rowKey: integrationId, ...integration });

         const { credentials: _, ...safeIntegration } = integration; 
         return { status: 201, jsonBody: { ...safeIntegration, config, message: "Integración creada con éxito" } }; 
     } catch (error) {
         this.logger.error("Error al crear integración de Google Calendar:", error);
         const appError = toAppError(error);
         return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
     }
  }

  async updateIntegration(integrationId: string, data: any, userId: string): Promise<HttpResponseInit> {
    try {
        const integration = await this.fetchIntegration(integrationId);
        if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
        const hasAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, userId);
        if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para modificar esta integración." } };
        
        if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
            return { status: 400, jsonBody: { error: "Esta operación solo es válida para integraciones de Google Calendar." } };
        }

        const config = integration.config as IntegrationGoogleCalendarConfig;
        const updatedConfig: IntegrationGoogleCalendarConfig = { ...config };
        let configChanged = false;

        if (data.config?.calendarId !== undefined && data.config.calendarId !== updatedConfig.calendarId) {
            updatedConfig.calendarId = data.config.calendarId;
            configChanged = true;
        }
        if (data.config?.timezone !== undefined && data.config.timezone !== updatedConfig.timezone) {
            updatedConfig.timezone = data.config.timezone;
            configChanged = true;
        }
        if (data.config?.maxConcurrentAppointments !== undefined) {
            const newMax = Number(data.config.maxConcurrentAppointments);
            if (!isNaN(newMax) && newMax >= 0 && newMax !== updatedConfig.maxConcurrentAppointments) {
                updatedConfig.maxConcurrentAppointments = newMax;
                configChanged = true;
            }
        }
        // Si se proveen nuevos tokens, actualizarlos (normalmente por re-autenticación)
        if (data.config?.accessToken) {
            updatedConfig.accessToken = data.config.accessToken;
            updatedConfig.expiresAt = data.config.expiresAt || (Date.now() + 3599 * 1000);
            if (data.config.refreshToken) updatedConfig.refreshToken = data.config.refreshToken;
            configChanged = true; 
        }


        const updatePayload: any = { partitionKey: integration.agentId, rowKey: integrationId, updatedAt: Date.now() };
        if (data.name !== undefined && data.name !== integration.name) updatePayload.name = data.name;
        if (data.description !== undefined && data.description !== integration.description) updatePayload.description = data.description;
        if (data.status !== undefined && data.status !== integration.status) updatePayload.status = data.status;
        if (data.isActive !== undefined && data.isActive !== integration.isActive) updatePayload.isActive = data.isActive;
        
        if (configChanged) {
            updatePayload.config = JSON.stringify(updatedConfig);
             // Actualizar credentials si el token cambió
             if (data.config?.accessToken) {
                updatePayload.credentials = updatedConfig.refreshToken || updatedConfig.accessToken;
            }
        }
        
        if (Object.keys(updatePayload).length <= 3 && !configChanged) { 
             return {status: 200, jsonBody: { message: "No se realizaron cambios.", id: integrationId }};
        }

        const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
        await tableClient.updateEntity(updatePayload, "Merge");

        const finalIntegration = await this.fetchIntegration(integrationId); 
        if (!finalIntegration) throw new Error("Error al re-obtener la integración actualizada.");
        
        // Devolver la config parseada y sin tokens sensibles
        const { credentials: _, config: rawFinalConfig, ...safeFinalIntegration } = finalIntegration;
        const finalConfigObject = rawFinalConfig as IntegrationGoogleCalendarConfig;
        const sanitizedFinalConfig = {
            calendarId: finalConfigObject.calendarId, 
            scope: finalConfigObject.scope, 
            expiresAt: finalConfigObject.expiresAt,
            timezone: finalConfigObject.timezone,
            maxConcurrentAppointments: finalConfigObject.maxConcurrentAppointments,
            hasRefreshToken: !!finalConfigObject.refreshToken
        };

        return { status: 200, jsonBody: { ...safeFinalIntegration, config: sanitizedFinalConfig, message: "Integración de Google Calendar actualizada." } };
    } catch (error) {
        this.logger.error(`Error al actualizar integración Google Calendar ${integrationId}:`, error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
 }

  async deleteIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
        const integration = await this.fetchIntegration(integrationId);
        if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
        const hasAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, userId);
        if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para eliminar esta integración." } };

        const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
        await tableClient.updateEntity({
            partitionKey: integration.agentId, rowKey: integrationId,
            isActive: false, status: IntegrationStatus.PENDING, // O EXPIRED
            updatedAt: Date.now()
        }, "Merge");

        const config = integration.config as IntegrationGoogleCalendarConfig;
        if (config.accessToken) await this.revokeToken(config.accessToken);
        if (config.refreshToken) await this.revokeToken(config.refreshToken);

        return { status: 200, jsonBody: { id: integrationId, message: "Integración de Google Calendar eliminada (desactivada y tokens revocados)." } };
    } catch (error) {
        this.logger.error(`Error al eliminar integración Google Calendar ${integrationId}:`, error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
 }

  private async refreshToken(integration: Integration): Promise<{
    success: boolean;
    accessToken?: string;
    expiresAt?: number;
    error?: string;
  }> {
    try {
      const config = integration.config as IntegrationGoogleCalendarConfig; 
      if (!config.refreshToken) {
        this.logger.error(`No hay refresh token para ${integration.id}. Requiere re-autenticación.`);
        await this.updateIntegrationStatus(integration.id, integration.agentId, IntegrationStatus.EXPIRED);
        return { success: false, error: "No hay refresh token. Requiere re-autenticación." };
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      oauth2Client.setCredentials({ refresh_token: config.refreshToken });

      const { credentials } = await oauth2Client.refreshAccessToken();
      if (!credentials.access_token) throw new Error("No se obtuvo nuevo access_token.");

      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      const updatedConfig: IntegrationGoogleCalendarConfig = {
        ...config,
        accessToken: credentials.access_token,
        expiresAt: credentials.expiry_date || (Date.now() + 3599 * 1000),
        refreshToken: credentials.refresh_token || config.refreshToken 
      };

      await tableClient.updateEntity({
        partitionKey: integration.agentId, rowKey: integration.id,
        config: JSON.stringify(updatedConfig), updatedAt: Date.now(),
        credentials: updatedConfig.refreshToken || updatedConfig.accessToken,
        status: IntegrationStatus.ACTIVE
      }, "Merge");

      this.logger.info(`Token actualizado y guardado para integración ${integration.id}`);
      // Actualizar el objeto 'integration' en memoria para que el caller lo use si es necesario
      (integration.config as IntegrationGoogleCalendarConfig).accessToken = updatedConfig.accessToken;
      (integration.config as IntegrationGoogleCalendarConfig).expiresAt = updatedConfig.expiresAt;
      if (credentials.refresh_token) {
          (integration.config as IntegrationGoogleCalendarConfig).refreshToken = credentials.refresh_token;
      }

      return { success: true, accessToken: credentials.access_token, expiresAt: updatedConfig.expiresAt };
    } catch (error: any) {
      this.logger.error(`Error al actualizar token para integración ${integration.id}:`, error);
      if (error.response?.data?.error === 'invalid_grant') {
          await this.updateIntegrationStatus(integration.id, integration.agentId, IntegrationStatus.EXPIRED);
          return { success: false, error: "Token de refresco inválido. Requiere re-autenticación." };
      }
      await this.updateIntegrationStatus(integration.id, integration.agentId, IntegrationStatus.ERROR);
      return { success: false, error: toAppError(error).message };
    }
  }

  private async fetchIntegration(integrationId: string): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      for await (const entity of integrations) {
         if (typeof entity.config === 'string') {
             try { entity.config = JSON.parse(entity.config); }
             catch (e) { this.logger.warn(`Error parseando config JSON para integración ${integrationId}:`, e); entity.config = {}; }
         } else if (entity.config === null || entity.config === undefined) { entity.config = {}; }
        return entity as unknown as Integration;
      }
      return null;
    } catch (error) {
      this.logger.error(`Error al buscar integración ${integrationId}:`, error);
      return null;
    }
  }

  private async verifyAccess(agentId: string, userId: string): Promise<boolean> {
     try {
        const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
        try {
            const agent = await agentsTable.getEntity('agent', agentId);
            if (agent.userId === userId) return true;
        } catch (error: any) { if (error.statusCode !== 404) this.logger.warn(`Error buscando agente ${agentId}:`, error); }

        const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
        const roles = rolesTable.listEntities({ queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` } });
        for await (const role of roles) { return true; }
        return false;
      } catch (error) {
        this.logger.error(`Error verificando acceso agente ${agentId} para user ${userId}:`, error);
        return false;
      }
  }

  private async revokeToken(token: string): Promise<void> {
    if (!token) return;
    try {
        const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' });
        if (response.ok) {
            this.logger.info("Token de Google revocado exitosamente (o ya era inválido).");
        } else {
            this.logger.warn(`Fallo al revocar token de Google (status ${response.status}): ${await response.text()}`);
        }
    } catch (error) {
        this.logger.warn("Error de red al intentar revocar token de Google:", error);
    }
  }

  private async updateIntegrationStatus(integrationId: string, agentId: string, status: IntegrationStatus): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity({
        partitionKey: agentId, rowKey: integrationId, status, updatedAt: Date.now()
      }, "Merge");
      this.logger.info(`Estado de integración ${integrationId} actualizado a ${status}`);
    } catch (error: any) {
         if (error.statusCode !== 404) {
            this.logger.error(`Error al actualizar estado de integración ${integrationId}:`, error);
         }
    }
  }

  private async verifyOwnerOrAdminAccess(agentId: string, userId: string): Promise<boolean> {
    try {
        const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
        try {
            const agent = await agentsTable.getEntity('agent', agentId);
            if (agent.userId === userId) { 
                 this.logger.debug(`Usuario ${userId} es dueño del agente ${agentId}. Acceso admin concedido.`);
                 return true;
            }
        } catch (error: any) {
            if (error.statusCode !== 404) this.logger.warn(`Error buscando agente ${agentId} para verificar propiedad de ${userId}:`, error);
        }

        const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
        const roles = rolesTable.listEntities({ 
            queryOptions: { 
                filter: `agentId eq '${agentId}' and userId eq '${userId}' and role eq '${RoleType.ADMIN}' and isActive eq true` 
            }
        });
        for await (const role of roles) {
            this.logger.debug(`Usuario ${userId} tiene rol ADMIN en agente ${agentId}. Acceso admin concedido.`);
            return true; 
        }
        
        this.logger.debug(`Usuario ${userId} no es dueño ni admin del agente ${agentId}.`);
        return false;
      } catch (error) {
        this.logger.error(`Error crítico verificando acceso owner/admin del agente ${agentId} para user ${userId}:`, error);
        return false;
      }
  }

  /**
 * Método de respaldo para encontrar citas por número de WhatsApp
 * Usa búsqueda más amplia cuando getMyBookedEvents falla
 */
async findEventsByWhatsAppNumber(integrationId: string, whatsappNumber: string): Promise<any[]> {
    try {
        const integration = await this.fetchIntegration(integrationId);
        if (!integration) return [];
        
        const config = integration.config as IntegrationGoogleCalendarConfig;
        if (config.expiresAt < Date.now()) {
            const refreshResult = await this.refreshToken(integration);
            if (!refreshResult.success) return [];
            config.accessToken = refreshResult.accessToken || config.accessToken;
        }
        
        const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
        oauth2Client.setCredentials({ access_token: config.accessToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
        
        // Buscar TODOS los eventos recientes
        const now = new Date();
        const timeMin = now.toISOString();
        const timeMax = new Date(now.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString();
        
        const eventsResponse = await calendar.events.list({
            calendarId: config.calendarId,
            timeMin,
            timeMax,
            singleEvents: true,
            maxResults: 100
        });
        
        const allEvents = eventsResponse.data.items || [];
        this.logger.info(`Búsqueda amplia: ${allEvents.length} eventos totales`);
        
        // Normalizar el número de WhatsApp para comparación
        const normalizedInput = this.normalizeWhatsAppNumber(whatsappNumber);
        const simplifiedInput = normalizedInput.replace(/[^\d]/g, '');
        
        // Filtrar eventos manualmente
        return allEvents.filter(event => {
            // Buscar en cualquier campo que podría contener el número
            const metadata = event.extendedProperties?.private || {};
            const storedNumber = metadata[GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY] || '';
            const alternativeNumber = metadata[`${GOOGLE_CALENDAR_CONFIG.WHATSAPP_NUMBER_KEY}_raw`] || '';
            
            // Normalizar para comparación
            const simplifiedStored = storedNumber.replace(/[^\d]/g, '');
            const simplifiedAlt = alternativeNumber.replace(/[^\d]/g, '');
            
            // Buscar también en descripción y título como último recurso
            const descriptionMatch = event.description && 
                event.description.includes(whatsappNumber.replace('whatsapp:', ''));
            
            // Verificar coincidencias
            return (
                storedNumber === normalizedInput ||
                simplifiedStored === simplifiedInput ||
                alternativeNumber === whatsappNumber.replace('whatsapp:', '') ||
                simplifiedAlt === simplifiedInput ||
                descriptionMatch
            );
        });
    } catch (error) {
        this.logger.error(`Error en búsqueda amplia:`, error);
        return [];
    }
}
}