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

  async createEvent(integrationId: string, eventData: any, requestingUserId: string): Promise<HttpResponseInit> {
    let integration: Integration | null = null;
    let config: IntegrationGoogleCalendarConfig | null = null;
    try {
      integration = await this.fetchIntegration(integrationId);
      if (!integration) {
        return { status: 404, jsonBody: { success: false, error: "Integración no encontrada." } };
      }
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return { status: 400, jsonBody: { success: false, error: "La integración no es de Google Calendar." } };
      }
      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
        return { status: 400, jsonBody: { success: false, error: `La integración Google Calendar (${integration.name}) no está activa.` } };
      }
      
      config = integration.config as IntegrationGoogleCalendarConfig;
      const maxConcurrent = config.maxConcurrentAppointments ?? GOOGLE_CALENDAR_CONFIG.DEFAULT_MAX_CONCURRENT_APPOINTMENTS;

      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success || !refreshResult.accessToken || !refreshResult.expiresAt) {
          return { status: 401, jsonBody: { success: false, error: "Error al actualizar token de acceso.", details: refreshResult.error } };
        }
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }

      let { 
        summary, 
        start, 
        end, 
        location, 
        description, 
        attendees, 
        reminders,
        addConferenceCall = false, 
        sendNotifications = 'default' 
      } = eventData;

      if (!summary) throw createAppError(400, "Falta el título del evento (summary).");
      if (!start || (!start.dateTime && !start.date)) throw createAppError(400, "Falta fecha/hora de inicio válida (start).");
      
      const eventTimeZone = start.timeZone || config.timezone || (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC';
      if (start.dateTime && !start.timeZone) start.timeZone = eventTimeZone;

      if (!end && start.dateTime) {
           try {
               const startDateObj = new Date(start.dateTime);
               const durationMinutes = GOOGLE_CALENDAR_CONFIG.DEFAULT_APPOINTMENT_DURATION_MINUTES;
               const endDateObj = new Date(startDateObj.getTime() + durationMinutes * 60000);
               end = { dateTime: endDateObj.toISOString(), timeZone: start.timeZone };
               this.logger.info(`Hora de fin calculada: ${end.dateTime} (${end.timeZone})`);
           } catch (dateError) { throw createAppError(400, `Formato de start.dateTime inválido: ${start.dateTime}`); }
       } else if (!end && start.date) { 
             try {
               const startDateObj = new Date(start.date + 'T00:00:00Z'); 
               const endDateObj = new Date(startDateObj.getTime() + 24 * 60 * 60 * 1000);
               end = { date: endDateObj.toISOString().split('T')[0] };
               this.logger.info(`Fecha de fin calculada para evento de día completo: ${end.date}`);
             } catch (dateError){ throw createAppError(400, `Formato de start.date inválido: ${start.date}`); }
       }
      if (!end || (!end.dateTime && !end.date)) throw createAppError(400, "Falta fecha/hora de fin (end) y no se pudo calcular.");
      if (end.dateTime && !end.timeZone) end.timeZone = start.timeZone || eventTimeZone; 

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      oauth2Client.setCredentials({ access_token: config.accessToken, refresh_token: config.refreshToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      // Verificación de Concurrencia
      const checkTimeMin = start.dateTime || new Date(start.date + 'T00:00:00Z').toISOString(); 
      const checkTimeMax = end.dateTime || new Date(end.date + 'T23:59:59Z').toISOString(); 
      let existingEventsCount = 0;

      try {
          this.logger.info(`[${integration.id}] Verificando eventos en calendario '${config.calendarId}' entre ${checkTimeMin} y ${checkTimeMax}`);
          const existingEventsResponse = await calendar.events.list({
              calendarId: config.calendarId, timeMin: checkTimeMin, timeMax: checkTimeMax, singleEvents: true,
          });
          if (existingEventsResponse.data.items) {
              existingEventsCount = existingEventsResponse.data.items.length;
              this.logger.info(`[${integration.id}] Se encontraron ${existingEventsCount} eventos existentes en el horario.`);
          }
      } catch (listError: any) {
          this.logger.error(`[${integration.id}] Error al verificar eventos existentes:`, listError);
          // Devolvemos un error 500 porque la verificación en sí falló.
          return {
              status: 500, // Internal Server Error
              jsonBody: { 
                success: false, 
                error: "Error al verificar disponibilidad del calendario.", 
                message: "No se pudo comprobar si hay citas existentes. Intenta de nuevo más tarde.", 
                details: listError.message 
              }
          };
      }

      if (existingEventsCount >= maxConcurrent) {
          this.logger.warn(`[${integration.id}] Conflicto de concurrencia. Eventos existentes: ${existingEventsCount}, Límite: ${maxConcurrent}.`);
          let conflictMessage = `El horario solicitado de ${start.dateTime || start.date} a ${end.dateTime || end.date} ya ha alcanzado el límite de ${maxConcurrent} cita(s) permitida(s).`;
          if (maxConcurrent === 1) {
              conflictMessage = `El horario solicitado de ${start.dateTime || start.date} a ${end.dateTime || end.date} ya está ocupado. Por favor, elige otro horario.`;
          }
          // Usamos 409 (Conflict) para este error específico de disponibilidad.
          return {
              status: 409, // Conflict
              jsonBody: { 
                success: false, 
                error: "Límite de citas alcanzado o slot no disponible", 
                message: conflictMessage, 
                details: { existingEventsCount, maxConcurrentAppointments: maxConcurrent, requestedSlotUnavailable: true } // flag adicional
              }
          };
      }
      // Fin Verificación de Concurrencia

      this.logger.info(`[${integration.id}] Procediendo a crear evento. Eventos existentes: ${existingEventsCount}, Límite: ${maxConcurrent}.`);
      const eventRequestBody: calendar_v3.Schema$Event = {
        summary,
        location: typeof location === 'string' ? location : (location?.displayName || undefined),
        description,
        start: start as calendar_v3.Schema$EventDateTime,
        end: end as calendar_v3.Schema$EventDateTime,
        attendees: attendees ? attendees.map((att: any) => ({ email: att.email })) : undefined,
        reminders: reminders || { useDefault: true },
        extendedProperties: {
          private: {
            [GOOGLE_CALENDAR_CONFIG.BOOKED_BY_USER_ID_KEY]: requestingUserId 
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
        if (sendNotifications !== 'none') {
          determinedSendUpdates = "all"; 
        } else {
          determinedSendUpdates = "none";
        }
      } else if (sendNotifications !== 'default') {
        determinedSendUpdates = sendNotifications as "all" | "externalOnly" | "none";
      } else if (attendees && attendees.length > 0) {
        determinedSendUpdates = "all";
      }

      const response: GaxiosResponse<calendar_v3.Schema$Event> = await calendar.events.insert({ 
        calendarId: config.calendarId, 
        requestBody: eventRequestBody,
        conferenceDataVersion: addConferenceCall ? 1 : 0, 
        sendUpdates: determinedSendUpdates 
      });
      const createdEvent = response.data;
      this.logger.info(`Evento ${createdEvent.id} creado en calendario ${config.calendarId} por ${requestingUserId}. Conferencia: ${addConferenceCall}. Notificaciones: ${determinedSendUpdates || 'predeterminado de Google'}.`);

      return {
        status: 201,
        jsonBody: {
          success: true, message: "Evento creado con éxito.",
          result: { 
            id: createdEvent.id, 
            summary: createdEvent.summary, 
            htmlLink: createdEvent.htmlLink,       
            hangoutLink: createdEvent.hangoutLink,  
            start: createdEvent.start, 
            end: createdEvent.end, 
            created: createdEvent.created,
            conferenceData: createdEvent.conferenceData 
          }
        }
      };
    } catch (error) {
      this.logger.error(`Error al crear evento para integración ${integrationId} solicitado por ${requestingUserId}:`, error);
      const appError = toAppError(error);
      // Si el error ya es 409, mantenerlo.
      const statusCode = (error as any).statusCode === 409 ? 409 : appError.statusCode;
      return { 
        status: statusCode, 
        jsonBody: { 
            success: false, 
            error: appError.message, 
            details: appError.details,
            requestedSlotUnavailable: statusCode === 409 // Añadir flag si es un 409
        } 
      };
    }
  }

  async updateEvent(integrationId: string, eventId: string, eventData: any, requestingUserId: string): Promise<HttpResponseInit> {
    let integration: Integration | null = null;
    let config: IntegrationGoogleCalendarConfig | null = null;
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

      let existingEvent: calendar_v3.Schema$Event;
      try {
        const getResponse = await calendar.events.get({ calendarId: config.calendarId, eventId });
        existingEvent = getResponse.data;
        if (!existingEvent) throw new Error("Evento no encontrado para actualizar.");
      } catch (getError: any) {
        if (getError.code === 404) return { status: 404, jsonBody: { success: false, error: "La cita que intentas modificar no fue encontrada." }};
        this.logger.error(`Error obteniendo evento ${eventId} para actualizar:`, getError);
        throw createAppError(500, "Error al verificar la cita existente antes de actualizar.");
      }

      const bookedByUserId = existingEvent.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.BOOKED_BY_USER_ID_KEY];
      const isAdminAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, requestingUserId);

      if (bookedByUserId && bookedByUserId !== requestingUserId && !isAdminAccess) {
        this.logger.warn(`Acceso denegado: Usuario ${requestingUserId} intentó modificar evento ${eventId} de ${bookedByUserId} sin ser admin.`);
        return { status: 403, jsonBody: { success: false, error: "No tienes permiso para modificar esta cita porque pertenece a otro usuario." }};
      }
      if (isAdminAccess && bookedByUserId && bookedByUserId !== requestingUserId) {
          this.logger.info(`Admin ${requestingUserId} modificando evento ${eventId} de ${bookedByUserId}.`);
      }

      const updateBody: calendar_v3.Schema$Event = {};
      let conferenceDataModified = false;
      let determinedSendUpdates: "all" | "externalOnly" | "none" | undefined = undefined;

      if (eventData.summary !== undefined) updateBody.summary = eventData.summary;
      if (eventData.location !== undefined) updateBody.location = typeof eventData.location === 'string' ? eventData.location : eventData.location?.displayName;
      if (eventData.description !== undefined) updateBody.description = eventData.description;
      if (eventData.start !== undefined) updateBody.start = eventData.start as calendar_v3.Schema$EventDateTime;
      if (eventData.end !== undefined) updateBody.end = eventData.end as calendar_v3.Schema$EventDateTime;
      if (eventData.attendees !== undefined) { // Permitir pasar un array vacío para eliminar todos los asistentes
        updateBody.attendees = eventData.attendees.map((att: any) => ({ email: att.email }));
      }
      if (eventData.reminders !== undefined) updateBody.reminders = eventData.reminders;

      if (eventData.addConferenceCall !== undefined) {
        conferenceDataModified = true;
        if (eventData.addConferenceCall === true) {
          updateBody.conferenceData = {
            createRequest: {
              requestId: uuidv4(),
              conferenceSolutionKey: { type: "hangoutsMeet" }
            }
          };
        } else { 
          (updateBody as any).conferenceData = null; // API de Google usa null para borrar
        }
      }
      
      const sendNotifications = eventData.sendNotifications || 'default';
      if (sendNotifications !== 'default') {
          determinedSendUpdates = sendNotifications as "all" | "externalOnly" | "none";
      } else if (updateBody.attendees && updateBody.attendees.length > 0 && (eventData.addConferenceCall === undefined || eventData.addConferenceCall === false )) {
          determinedSendUpdates = "all";
      } else if (eventData.addConferenceCall === true && sendNotifications !== 'none') {
           determinedSendUpdates = "all"; 
      }

      if (Object.keys(updateBody).length === 0 && !conferenceDataModified) { // Ajuste: verificar también conferenceDataModified
           return { status: 200, jsonBody: { success: true, message: "No se especificaron cambios para el evento.", result: { id: eventId } }};
      }
      
      if (!updateBody.extendedProperties && existingEvent.extendedProperties) {
        updateBody.extendedProperties = existingEvent.extendedProperties;
      } else if (updateBody.extendedProperties || (updateBody.extendedProperties === undefined && existingEvent.extendedProperties && !existingEvent.extendedProperties.private?.[GOOGLE_CALENDAR_CONFIG.BOOKED_BY_USER_ID_KEY])) {
          // Asegurar que bookedByUserId se preserve si existe, o se establezca si no.
         updateBody.extendedProperties = updateBody.extendedProperties || {};
         updateBody.extendedProperties.private = {
            ...(updateBody.extendedProperties.private || {}),
            [GOOGLE_CALENDAR_CONFIG.BOOKED_BY_USER_ID_KEY]: bookedByUserId || requestingUserId
         };
      }


      const response: GaxiosResponse<calendar_v3.Schema$Event> = await calendar.events.update({ 
          calendarId: config.calendarId, 
          eventId, 
          requestBody: updateBody,
          conferenceDataVersion: conferenceDataModified ? 1 : 0, 
          sendUpdates: determinedSendUpdates
      });
      const updatedEvent = response.data;
      this.logger.info(`Evento ${updatedEvent.id} actualizado en calendario ${config.calendarId} por ${requestingUserId}.`);

      return {
        status: 200,
        jsonBody: {
          success: true, message: "Evento actualizado con éxito.",
          result: { 
              id: updatedEvent.id, 
              summary: updatedEvent.summary, 
              htmlLink: updatedEvent.htmlLink, 
              hangoutLink: updatedEvent.hangoutLink,
              updated: updatedEvent.updated,
              start: updatedEvent.start, // Devolver start/end actualizados
              end: updatedEvent.end,
              attendees: updatedEvent.attendees,
              conferenceData: updatedEvent.conferenceData
            }
        }
      };
    } catch (error:any) {
      if (error.code === 412) { 
          this.logger.warn(`Fallo al actualizar evento ${eventId} debido a ETag mismatch (modificación concurrente).`);
          return { status: 412, jsonBody: { success: false, error: "La cita fue modificada por otra persona mientras intentabas guardarla. Por favor, recarga y vuelve a intentarlo." } };
      }
      this.logger.error(`Error al actualizar evento ${eventId} para integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
    }
  }
  
  async deleteEvent(integrationId: string, eventId: string, requestingUserId: string, eventData: any = {}): Promise<HttpResponseInit> {
    let integration: Integration | null = null;
    let config: IntegrationGoogleCalendarConfig | null = null;
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

      try {
        const getResponse: GaxiosResponse<calendar_v3.Schema$Event> = await calendar.events.get({ calendarId: config.calendarId, eventId });
        const bookedByUserId = getResponse.data?.extendedProperties?.private?.[GOOGLE_CALENDAR_CONFIG.BOOKED_BY_USER_ID_KEY];
        
        const isAdminAccess = await this.verifyOwnerOrAdminAccess(integration.agentId, requestingUserId);
        if (bookedByUserId && bookedByUserId !== requestingUserId && !isAdminAccess) {
          this.logger.warn(`Acceso denegado: Usuario ${requestingUserId} intentó eliminar evento ${eventId} de ${bookedByUserId} sin ser admin.`);
          return { status: 403, jsonBody: { success: false, error: "No tienes permiso para eliminar esta cita porque pertenece a otro usuario." }};
        }
         if (isAdminAccess && bookedByUserId && bookedByUserId !== requestingUserId) {
             this.logger.info(`Admin ${requestingUserId} eliminando evento ${eventId} de ${bookedByUserId}.`);
         }

      } catch (getError: any) {
        if (getError.code === 404) {
          this.logger.warn(`Intento de eliminar evento ${eventId} que no fue encontrado. Considerado éxito.`);
          return { status: 200, jsonBody: { success: true, message: "La cita ya había sido eliminada o no existía.", result: { id: eventId } }};
        }
        this.logger.error(`Error obteniendo evento ${eventId} para eliminar:`, getError);
        throw createAppError(500, "Error al verificar la cita existente antes de eliminar.");
      }
      
      const sendCancelNotificationsOption = eventData.sendNotifications || 'default';
      let sendUpdatesValue: "all" | "none" | "externalOnly" = "all"; 
      if (sendCancelNotificationsOption === 'none') {
          sendUpdatesValue = "none";
      } else if (sendCancelNotificationsOption === 'externalOnly') {
          sendUpdatesValue = "externalOnly";
      }
      
      await calendar.events.delete({ 
          calendarId: config.calendarId, 
          eventId,
          sendUpdates: sendUpdatesValue 
      });
      this.logger.info(`Evento ${eventId} eliminado de calendario ${config.calendarId} por ${requestingUserId}. Notificaciones de cancelación: ${sendUpdatesValue}.`);

      return {
          status: 200,
          jsonBody: { success: true, message: "Evento eliminado con éxito.", result: { id: eventId } }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar evento ${eventId} para integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
    }
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

        const timeMin = options.startDate ? new Date(options.startDate).toISOString() : new Date(0).toISOString(); 
        const timeMax = options.endDate ? new Date(options.endDate).toISOString() : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(); 

        const listParams: calendar_v3.Params$Resource$Events$List = {
            calendarId: config.calendarId,
            timeMin,
            timeMax,
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 250, 
           privateExtendedProperty: [`${GOOGLE_CALENDAR_CONFIG.BOOKED_BY_USER_ID_KEY}=${requestingUserId}`]
        };
        
        const eventsResponse: GaxiosResponse<calendar_v3.Schema$Events> = await calendar.events.list(listParams);

        const myBookedEvents = eventsResponse.data.items || [];
        
        this.logger.info(`[${integrationId}] Se encontraron ${myBookedEvents.length} eventos agendados por usuario ${requestingUserId} usando filtro de propiedad extendida.`);

        return {
            status: 200,
            jsonBody: {
                success: true,
                message: myBookedEvents.length > 0 ? `Se encontraron ${myBookedEvents.length} citas agendadas por ti.` : "No se encontraron citas agendadas por ti en el periodo solicitado.",
                result: {
                    integrationId,
                    calendarId: config.calendarId,
                    events: myBookedEvents.map((e: calendar_v3.Schema$Event) => ({ // Tipo explícito para 'e'
                        id: e.id, 
                        summary: e.summary, 
                        start: e.start, 
                        end: e.end, 
                        location: e.location,
                        description: e.description,
                        htmlLink: e.htmlLink,
                        hangoutLink: e.hangoutLink
                    })),
                    period: { start: timeMin, end: timeMax }
                }
            }
        };
    } catch (error) {
        this.logger.error(`Error al obtener mis eventos agendados para integración ${integrationId} y usuario ${requestingUserId}:`, error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
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
}