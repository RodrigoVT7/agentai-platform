// src/shared/handlers/integrations/googleCalendarHandler.ts

import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants"; // Asume que DEFAULT_APPOINTMENT_DURATION_MINUTES está aquí o en otro archivo de constantes
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils"; // Asegúrate de importar toAppError
import {
  Integration,
  IntegrationType,
  IntegrationStatus,
  IntegrationGoogleCalendarConfig
} from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";
import { google, calendar_v3 } from "googleapis"; // Importar tipos específicos

// Definir la constante para la duración predeterminada
const DEFAULT_APPOINTMENT_DURATION_MINUTES = 60;
const BOOKED_BY_USER_ID_KEY = 'bookedByUserId';

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
      this.logger.warn("Configuración de Google OAuth incompleta");
    }
  }

  /**
   * Genera la URL de autorización de Google OAuth 2.0.
   * Requiere verificación de acceso del usuario al agente.
   */
  async getAuthUrl(agentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar acceso del usuario al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return { status: 403, jsonBody: { error: "No tienes permiso para acceder a este agente" } };
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      const scopes = [
        'https://www.googleapis.com/auth/calendar', // Permiso completo
        'https://www.googleapis.com/auth/calendar.events' // Permiso específico para eventos
      ];
      const state = Buffer.from(JSON.stringify({ userId, agentId })).toString('base64');

      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // Solicitar refresh_token
        scope: scopes,
        state,
        prompt: 'consent' // Forzar pantalla de consentimiento para asegurar refresh_token
      });

      return { status: 200, jsonBody: { authUrl, message: "URL de autorización generada" } };
    } catch (error) {
      this.logger.error("Error al generar URL de autorización:", error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }

  /**
   * Procesa el código de autorización de Google OAuth 2.0, obtiene tokens y crea la integración.
   * Requiere verificación de acceso del usuario al agente.
   */
  async processAuthCode(code: string, userId: string, agentId: string): Promise<any> {
    try {
      // Verificar acceso del usuario al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para configurar este agente");
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      const { tokens } = await oauth2Client.getToken(code);

      if (!tokens.access_token) {
        throw createAppError(400, "No se pudo obtener token de acceso de Google");
      }

      oauth2Client.setCredentials(tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const calendarResponse = await calendar.calendarList.list();
      const primaryCalendar = calendarResponse.data.items?.find(cal => cal.primary) || calendarResponse.data.items?.[0];

      if (!primaryCalendar?.id) {
          throw createAppError(400, "No se pudo determinar el calendario principal del usuario.");
      }

      const integrationId = uuidv4();
      const now = Date.now();
      const config: IntegrationGoogleCalendarConfig = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '', // Guardar refresh token si existe
        expiresAt: tokens.expiry_date || 0,
        scope: Array.isArray(tokens.scope) ? tokens.scope.join(' ') : tokens.scope || '',
        calendarId: primaryCalendar.id
      };

      const integration: Integration = {
        id: integrationId, agentId, name: `Google Calendar (${primaryCalendar.summary || primaryCalendar.id})`,
        description: `Integración con Google Calendar (${primaryCalendar.summary})`,
        type: IntegrationType.CALENDAR, provider: 'google',
        config: JSON.stringify(config), // Guardar como JSON string
        credentials: config.refreshToken || config.accessToken, // Guardar refresh token si existe
        status: IntegrationStatus.ACTIVE, createdBy: userId, createdAt: now, isActive: true
      };

      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.createEntity({ partitionKey: agentId, rowKey: integrationId, ...integration });

      this.logger.info(`Integración Google Calendar ${integrationId} creada para agente ${agentId}`);
      return { integrationId, success: true }; // Devuelve el ID para redirección/confirmación

    } catch (error) {
      this.logger.error("Error al procesar código de autorización de Google:", error);
      // Relanzar como AppError estandarizado
      throw toAppError(error);
    }
  }

  /**
   * Obtiene eventos del calendario asociado a la integración.
   * NO verifica el acceso del 'userId' porque se asume que es llamado por el flujo del agente.
   */
  async getEvents(integrationId: string, userId: string, options: { startDate?: string, endDate?: string }): Promise<HttpResponseInit> {
    let config: IntegrationGoogleCalendarConfig | null = null;
    try {
      // 1. Verificar integración
      const integration = await this.fetchIntegration(integrationId);
      if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
      }
      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
        return { status: 400, jsonBody: { error: `La integración Google Calendar (${integration.name}) no está activa.` } };
      }
      config = integration.config as IntegrationGoogleCalendarConfig; // Asumir parseado

      // 2. Refrescar token si es necesario
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) return { status: 401, jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error } };
        if (refreshResult.accessToken) config.accessToken = refreshResult.accessToken;
        if (refreshResult.expiresAt) config.expiresAt = refreshResult.expiresAt;
      }

      // 3. Crear cliente y obtener eventos
      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      oauth2Client.setCredentials({ access_token: config.accessToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      const timeMin = options.startDate ? new Date(options.startDate).toISOString() : new Date().toISOString();
      const timeMax = options.endDate ? new Date(options.endDate).toISOString() : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

      const eventsResponse = await calendar.events.list({
        calendarId: config.calendarId, timeMin, timeMax, singleEvents: true, orderBy: 'startTime'
      });
      const events = eventsResponse.data.items || [];

      // 4. Devolver resultado
      return {
        status: 200,
        jsonBody: {
          success: true, // Flag de éxito
          message: `Se encontraron ${events.length} eventos.`, // Mensaje para LLM
          result: { // Objeto con detalles
              integrationId,
              calendarId: config.calendarId,
              events: events.map(e => ({ id: e.id, summary: e.summary, start: e.start, end: e.end })), // Simplificar eventos
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

    /**
   * Crea un nuevo evento en Google Calendar, calculando la hora de fin si no se proporciona
   * y almacenando el ID del usuario que reserva.
   * @param integrationId ID de la integración de Google Calendar
   * @param eventData Datos del evento proporcionados por el LLM
   * @param requestingUserId ID del usuario que reserva (el endUserId en el flujo del agente)
   * @returns Resultado de la creación del evento
   */
    async createEvent(integrationId: string, eventData: any, requestingUserId: string): Promise<HttpResponseInit> {
      let config: IntegrationGoogleCalendarConfig | null = null;
      try {
        // 1. Verificar integración
        const integration = await this.fetchIntegration(integrationId);
        if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
        if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
          return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
        }
        if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
          return { status: 400, jsonBody: { error: `La integración Google Calendar (${integration.name}) no está activa.` } };
        }
        config = integration.config as IntegrationGoogleCalendarConfig;
  
        // 2. Refrescar token si es necesario
        if (config.expiresAt < Date.now()) {
          const refreshResult = await this.refreshToken(integration);
          if (!refreshResult.success) return { status: 401, jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error } };
          if (refreshResult.accessToken) config.accessToken = refreshResult.accessToken;
          if (refreshResult.expiresAt) config.expiresAt = refreshResult.expiresAt;
        }
  
        // 3. Preparar datos del evento y calcular fin si falta
        let { summary, start, end, location, description, attendees, reminders } = eventData;
        if (!summary) throw createAppError(400, "Falta el título del evento (summary).");
        if (!start || (!start.dateTime && !start.date)) throw createAppError(400, "Falta fecha/hora de inicio válida (start).");
        if (start.dateTime && !start.timeZone) {
             this.logger.warn(`Falta timeZone en 'start' para evento ${summary}. Usando UTC como fallback.`);
             start.timeZone = 'UTC';
        }
  
        if (!end && start.dateTime) {
             try {
                 const startDate = new Date(start.dateTime);
                 const durationMinutes = DEFAULT_APPOINTMENT_DURATION_MINUTES;
                 const endDate = new Date(startDate.getTime() + durationMinutes * 60000);
                 end = { dateTime: endDate.toISOString(), timeZone: start.timeZone };
                 this.logger.info(`Hora de fin calculada automáticamente: ${end.dateTime} (${end.timeZone})`);
             } catch (dateError) { throw createAppError(400, `Formato de start.dateTime inválido: ${start.dateTime}`); }
         } else if (!end && start.date) {
               try {
                 const startDate = new Date(start.date + 'T00:00:00Z');
                 const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
                 end = { date: endDate.toISOString().split('T')[0] };
                 this.logger.info(`Fecha de fin calculada para evento de día completo: ${end.date}`);
               } catch (dateError){ throw createAppError(400, `Formato de start.date inválido: ${start.date}`); }
         }
        if (!end || (!end.dateTime && !end.date)) throw createAppError(400, "Falta fecha/hora de fin (end). No se pudo calcular.");
  
        // 4. Crear cliente OAuth y Calendar
        const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
        oauth2Client.setCredentials({ access_token: config.accessToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
        // 5. Construir el cuerpo de la solicitud con tipos correctos y propiedades extendidas
        const eventRequestBody: calendar_v3.Schema$Event = {
          summary,
          location: typeof location === 'object' ? location.displayName : location,
          description,
          start: start as calendar_v3.Schema$EventDateTime,
          end: end as calendar_v3.Schema$EventDateTime,
          attendees: attendees ? attendees.map((att: any) => ({ email: att.email })) : undefined,
          reminders: reminders || { useDefault: true },
          // *** Usar la constante definida ***
          extendedProperties: {
            private: {
              [BOOKED_BY_USER_ID_KEY]: requestingUserId // Guardar el ID del usuario que reserva
            }
          }
        };
  
        // 6. Crear evento
        this.logger.info(`Creando evento en Google Calendar (ID: ${config.calendarId}) para usuario ${requestingUserId}:`, eventRequestBody);
        const response = await calendar.events.insert({ calendarId: config.calendarId, requestBody: eventRequestBody });
        const createdEvent = response.data;
        this.logger.info(`Evento ${createdEvent.id} creado exitosamente por ${requestingUserId}.`);
  
        // 7. Devolver respuesta exitosa
        return {
          status: 201,
          jsonBody: {
            success: true, message: "Evento creado con éxito",
            result: { id: createdEvent.id, summary: createdEvent.summary, htmlLink: createdEvent.htmlLink,
                      start: createdEvent.start, end: createdEvent.end, created: createdEvent.created }
          }
        };
      } catch (error) {
        this.logger.error(`Error al crear evento para integración ${integrationId} solicitado por ${requestingUserId}:`, error);
        const appError = toAppError(error);
        return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
      }
    }
  
  /**
   * Actualiza un evento existente, verificando que el usuario solicitante sea el propietario.
   * Combina los datos existentes con los nuevos datos proporcionados.
   * @param integrationId ID de la integración
   * @param eventId ID del evento a actualizar
   * @param eventData Nuevos datos para el evento (solo los campos a cambiar)
   * @param requestingUserId ID del usuario que solicita la actualización
   * @returns Resultado de la actualización
   */
  async updateEvent(integrationId: string, eventId: string, eventData: any, requestingUserId: string): Promise<HttpResponseInit> {
    let config: IntegrationGoogleCalendarConfig | null = null;
    try {
      // 1. Verificar integración
      const integration = await this.fetchIntegration(integrationId);
      if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
      }
      if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
        return { status: 400, jsonBody: { error: `La integración Google Calendar (${integration.name}) no está activa.` } };
      }
      config = integration.config as IntegrationGoogleCalendarConfig;

      // 2. Refrescar token si es necesario
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) return { status: 401, jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error } };
        if (refreshResult.accessToken) config.accessToken = refreshResult.accessToken;
        if (refreshResult.expiresAt) config.expiresAt = refreshResult.expiresAt;
      }

      // 3. Crear cliente y API de Calendar
      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      oauth2Client.setCredentials({ access_token: config.accessToken });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      // 4. *** OBTENER EVENTO EXISTENTE Y VERIFICAR PROPIETARIO ***
      let existingEvent: calendar_v3.Schema$Event;
      let bookedByUserId: string | undefined;
      try {
          this.logger.debug(`Obteniendo evento ${eventId} para verificar propietario y obtener datos actuales...`);
          const getResponse = await calendar.events.get({ calendarId: config.calendarId, eventId });
          existingEvent = getResponse.data; // Guardar datos actuales
          if (!existingEvent) throw new Error("No se recibieron datos del evento existente."); // Seguridad extra

          bookedByUserId = existingEvent.extendedProperties?.private?.[BOOKED_BY_USER_ID_KEY];
          this.logger.debug(`Evento ${eventId} reservado por: ${bookedByUserId}. Solicitante: ${requestingUserId}`);

          if (bookedByUserId && bookedByUserId !== requestingUserId) {
              this.logger.warn(`Acceso denegado: Usuario ${requestingUserId} intentó modificar evento ${eventId} reservado por ${bookedByUserId}`);
              return { status: 403, jsonBody: { success: false, error: "No tienes permiso para modificar esta cita porque pertenece a otro usuario." } };
          }
          if (!bookedByUserId) {
              this.logger.warn(`Evento ${eventId} no tiene propietario registrado (${BOOKED_BY_USER_ID_KEY}). Permitiendo modificación por ${requestingUserId}.`);
          }

      } catch (getError: any) {
          if (getError.code === 404) {
              return { status: 404, jsonBody: { success: false, error: "La cita que intentas modificar no fue encontrada." } };
          }
          this.logger.error(`Error al obtener evento ${eventId} para verificación:`, getError);
          throw createAppError(500, "Error al verificar la cita existente.");
      }
      // --- FIN Verificación ---

      // 5. *** COMBINAR DATOS EXISTENTES CON NUEVOS DATOS ***
      //    Construir el cuerpo de la actualización usando los datos existentes
      //    como base y sobrescribiendo solo los campos proporcionados en eventData.
      const updateBody: calendar_v3.Schema$Event = {
          // Mantener campos existentes
          summary: eventData.summary !== undefined ? eventData.summary : existingEvent.summary,
          location: eventData.location !== undefined ? (typeof eventData.location === 'object' ? eventData.location.displayName : eventData.location) : existingEvent.location,
          description: eventData.description !== undefined ? eventData.description : existingEvent.description,
          start: eventData.start !== undefined ? eventData.start as calendar_v3.Schema$EventDateTime : existingEvent.start,
          end: eventData.end !== undefined ? eventData.end as calendar_v3.Schema$EventDateTime : existingEvent.end,
          attendees: eventData.attendees !== undefined ? eventData.attendees.map((att: any) => ({ email: att.email })) : existingEvent.attendees,
          reminders: eventData.reminders !== undefined ? eventData.reminders : existingEvent.reminders,
          // Mantener o añadir propietario
          extendedProperties: {
              private: {
                  ...existingEvent.extendedProperties?.private, // Mantener otras propiedades si existen
                  [BOOKED_BY_USER_ID_KEY]: bookedByUserId || requestingUserId // Mantener o añadir
              }
          },
          // Importante: Mantener otros campos que no se modifican explícitamente
          // como recurrence, status, etc., si es necesario.
          // Por simplicidad, aquí solo incluimos los más comunes.
          // Si necesitas mantener más campos, agrégalos aquí desde 'existingEvent'.
          // Ejemplo: status: existingEvent.status,
      };

      // Validar que al menos algo cambió (opcional, pero evita llamadas innecesarias)
      // if (JSON.stringify(updateBody) === JSON.stringify(existingEvent)) {
      //      return { status: 200, jsonBody: { message: "No se detectaron cambios en la cita." } };
      // }


      // 6. Actualizar evento
      this.logger.info(`Actualizando evento ${eventId} en Google Calendar (ID: ${config.calendarId}) solicitado por ${requestingUserId}:`, updateBody);
      // Usar 'update' en lugar de 'patch' si quieres reemplazar todo el evento
      // Usar 'patch' si solo quieres enviar los campos modificados (requiere construir updateBody diferente)
      // 'update' es más seguro para asegurar que se mantienen los campos correctos.
      const response = await calendar.events.update({ calendarId: config.calendarId, eventId, requestBody: updateBody });
      const updatedEvent = response.data;
      this.logger.info(`Evento ${eventId} actualizado exitosamente por ${requestingUserId}.`);

      // 7. Devolver respuesta
      return {
        status: 200,
        jsonBody: {
          success: true, message: "Evento actualizado con éxito",
          result: { id: updatedEvent.id, summary: updatedEvent.summary, htmlLink: updatedEvent.htmlLink, updated: updatedEvent.updated }
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar evento ${eventId} para integración ${integrationId} solicitado por ${requestingUserId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
    }
  }
  
    /**
     * Elimina un evento de Google Calendar, verificando que el usuario solicitante sea el propietario.
     * @param integrationId ID de la integración
     * @param eventId ID del evento a eliminar
     * @param requestingUserId ID del usuario que solicita la eliminación
     * @returns Resultado de la eliminación
     */
    async deleteEvent(integrationId: string, eventId: string, requestingUserId: string): Promise<HttpResponseInit> {
       let config: IntegrationGoogleCalendarConfig | null = null;
       try {
           // 1. Verificar integración
           const integration = await this.fetchIntegration(integrationId);
           if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
           if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
               return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
           }
           if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
               return { status: 400, jsonBody: { error: `La integración Google Calendar (${integration.name}) no está activa.` } };
           }
           config = integration.config as IntegrationGoogleCalendarConfig;
  
           // 2. Refrescar token si es necesario
           if (config.expiresAt < Date.now()) {
               const refreshResult = await this.refreshToken(integration);
               if (!refreshResult.success) return { status: 401, jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error } };
               if (refreshResult.accessToken) config.accessToken = refreshResult.accessToken;
               if (refreshResult.expiresAt) config.expiresAt = refreshResult.expiresAt;
           }
  
           // 3. Crear cliente y API de Calendar
           const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
           oauth2Client.setCredentials({ access_token: config.accessToken });
           const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
  
           // 4. *** NUEVO: Obtener evento y verificar propietario ***
           try {
               this.logger.debug(`Obteniendo evento ${eventId} para verificar propietario antes de eliminar...`);
               const getResponse = await calendar.events.get({ calendarId: config.calendarId, eventId });
               // *** Usar la constante definida ***
               const bookedByUserId = getResponse.data?.extendedProperties?.private?.[BOOKED_BY_USER_ID_KEY];
               this.logger.debug(`Evento ${eventId} reservado por: ${bookedByUserId}. Solicitante: ${requestingUserId}`);
  
               if (bookedByUserId && bookedByUserId !== requestingUserId) {
                   this.logger.warn(`Acceso denegado: Usuario ${requestingUserId} intentó eliminar evento ${eventId} reservado por ${bookedByUserId}`);
                   return { status: 403, jsonBody: { success: false, error: "No tienes permiso para eliminar esta cita porque pertenece a otro usuario." } };
               }
               if (!bookedByUserId) {
                   // *** Usar la constante definida ***
                   this.logger.warn(`Evento ${eventId} no tiene propietario registrado (${BOOKED_BY_USER_ID_KEY}). Permitiendo eliminación por ${requestingUserId}.`);
               }
           } catch (getError: any) {
               if (getError.code === 404) {
                   // Si no se encuentra, considerar la eliminación como exitosa (idempotencia)
                   this.logger.warn(`Intento de eliminar evento ${eventId} que no fue encontrado (404 Not Found). Considerado éxito.`);
                   return { status: 200, jsonBody: { success: true, message: "La cita ya había sido eliminada.", result: { id: eventId } } };
               }
               this.logger.error(`Error al obtener evento ${eventId} para verificación de eliminación:`, getError);
               throw createAppError(500, "Error al verificar la cita existente antes de eliminar.");
           }
           // --- FIN Verificación ---
  
           // 5. Eliminar evento
           this.logger.info(`Eliminando evento ${eventId} de Google Calendar (ID: ${config.calendarId}) solicitado por ${requestingUserId}`);
           await calendar.events.delete({ calendarId: config.calendarId, eventId });
           this.logger.info(`Evento ${eventId} eliminado exitosamente por ${requestingUserId}.`);
  
           // 6. Devolver respuesta
           return {
               status: 200,
               jsonBody: { success: true, message: "Evento eliminado con éxito", result: { id: eventId } }
           };
       } catch (error) {
           this.logger.error(`Error al eliminar evento ${eventId} para integración ${integrationId} solicitado por ${requestingUserId}:`, error);
           const appError = toAppError(error);
           return { status: appError.statusCode, jsonBody: { success: false, error: appError.message, details: appError.details } };
       }
    }

  /**
   * Lista los calendarios disponibles para la cuenta asociada a la integración.
   * Requiere verificación de acceso del usuario a la integración.
   */
  async listCalendars(integrationId: string, userId: string): Promise<HttpResponseInit> {
    let config: IntegrationGoogleCalendarConfig | null = null;
    try {
        // 1. Verificar integración y acceso del USUARIO
        const integration = await this.fetchIntegration(integrationId);
        if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
        const hasAccess = await this.verifyAccess(integration.agentId, userId); // VERIFICAR ACCESO DEL USUARIO
        if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para acceder a esta integración" } };
        if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
            return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
        }
        if (integration.status !== IntegrationStatus.ACTIVE || !integration.isActive) {
            return { status: 400, jsonBody: { error: `La integración Google Calendar (${integration.name}) no está activa.` } };
        }
        config = integration.config as IntegrationGoogleCalendarConfig;

        // 2. Refrescar token si es necesario
        if (config.expiresAt < Date.now()) {
            const refreshResult = await this.refreshToken(integration);
            if (!refreshResult.success) return { status: 401, jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error } };
            if (refreshResult.accessToken) config.accessToken = refreshResult.accessToken;
            if (refreshResult.expiresAt) config.expiresAt = refreshResult.expiresAt;
        }

        // 3. Crear cliente y API de Calendar
        const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
        oauth2Client.setCredentials({ access_token: config.accessToken });
        const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

        // 4. Obtener lista de calendarios
        const calendarResponse = await calendar.calendarList.list();
        const calendars = calendarResponse.data.items || [];

        // 5. Formatear y devolver
        const formattedCalendars = calendars.map(cal => ({
            id: cal.id, summary: cal.summary, description: cal.description,
            primary: cal.primary || false, accessRole: cal.accessRole
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

  /**
   * Obtiene los detalles de una integración (sin credenciales sensibles).
   * Requiere verificación de acceso del usuario a la integración.
   */
  async getIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      const integration = await this.fetchIntegration(integrationId);
      if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
      const hasAccess = await this.verifyAccess(integration.agentId, userId); // VERIFICAR ACCESO DEL USUARIO
      if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para acceder a esta integración" } };

      const { credentials, config: rawConfig, ...safeIntegration } = integration;
      const config = rawConfig as IntegrationGoogleCalendarConfig; // Asumir parseado

      const sanitizedConfig = {
        calendarId: config.calendarId, scope: config.scope, expiresAt: config.expiresAt,
        hasRefreshToken: !!config.refreshToken
      };

      return { status: 200, jsonBody: { ...safeIntegration, config: sanitizedConfig } };
    } catch (error) {
      this.logger.error(`Error al obtener integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }

  /**
   * Crea una nueva integración manualmente (útil si los tokens se obtienen externamente).
   * Requiere verificación de acceso del usuario al agente.
   */
  async createIntegration(data: any, userId: string): Promise<HttpResponseInit> {
     try {
         const { agentId, name, description, accessToken, refreshToken, expiresAt, calendarId, scope } = data;

         const hasAccess = await this.verifyAccess(agentId, userId); // VERIFICAR ACCESO DEL USUARIO
         if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para modificar este agente" } };
         if (!accessToken) return { status: 400, jsonBody: { error: "Se requiere token de acceso" } };

         const integrationId = uuidv4();
         const now = Date.now();
         const config: IntegrationGoogleCalendarConfig = {
             accessToken, refreshToken: refreshToken || '', expiresAt: expiresAt || (now + 3600000),
             scope: scope || 'https://www.googleapis.com/auth/calendar', calendarId: calendarId || 'primary'
         };
         const integration: Integration = {
             id: integrationId, agentId, name: name || "Google Calendar",
             description: description || "Integración con Google Calendar", type: IntegrationType.CALENDAR,
             provider: 'google', config: JSON.stringify(config), credentials: refreshToken || accessToken,
             status: IntegrationStatus.ACTIVE, createdBy: userId, createdAt: now, isActive: true
         };

         const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
         await tableClient.createEntity({ partitionKey: agentId, rowKey: integrationId, ...integration });

         const { credentials: _, ...safeIntegration } = integration; // Excluir credenciales
         return { status: 201, jsonBody: { ...safeIntegration, config, message: "Integración creada con éxito" } }; // Devolver config parseado
     } catch (error) {
         this.logger.error("Error al crear integración de Google Calendar:", error);
         const appError = toAppError(error);
         return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
     }
  }

  /**
   * Actualiza la configuración de una integración existente.
   * Requiere verificación de acceso del usuario a la integración.
   */
  async updateIntegration(integrationId: string, data: any, userId: string): Promise<HttpResponseInit> {
     try {
         const integration = await this.fetchIntegration(integrationId);
         if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
         const hasAccess = await this.verifyAccess(integration.agentId, userId); // VERIFICAR ACCESO DEL USUARIO
         if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para modificar esta integración" } };
         if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
             return { status: 400, jsonBody: { error: "La integración no es de Google Calendar" } };
         }

         const config = integration.config as IntegrationGoogleCalendarConfig; // Asumir parseado
         const updatedConfig: IntegrationGoogleCalendarConfig = { ...config };
         let needsSave = false;

         // Actualizar campos permitidos
         if (data.calendarId !== undefined && data.calendarId !== config.calendarId) {
             updatedConfig.calendarId = data.calendarId;
             needsSave = true;
         }
         // Podrías permitir actualizar otros campos de config si fuera necesario

         const updateData: any = { partitionKey: integration.agentId, rowKey: integrationId, updatedAt: Date.now() };
         if (data.name !== undefined && data.name !== integration.name) { updateData.name = data.name; needsSave = true; }
         if (data.description !== undefined && data.description !== integration.description) { updateData.description = data.description; needsSave = true; }
         if (data.status !== undefined && data.status !== integration.status) { updateData.status = data.status; needsSave = true; }
         if (needsSave) { updateData.config = JSON.stringify(updatedConfig); } // Guardar config si cambió

         if (!needsSave && !updateData.name && !updateData.description && !updateData.status) {
              return { status: 200, jsonBody: { message: "No se realizaron cambios." } }; // No hay nada que actualizar
         }

         const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
         await tableClient.updateEntity(updateData, "Merge");

         // Devolver la integración actualizada (sin credenciales)
         const finalIntegration = { ...integration, ...updateData, config: updatedConfig };
         const { credentials: _, ...safeIntegration } = finalIntegration;
         const sanitizedConfig = { calendarId: updatedConfig.calendarId, scope: updatedConfig.scope, expiresAt: updatedConfig.expiresAt, hasRefreshToken: !!updatedConfig.refreshToken };

         return { status: 200, jsonBody: { ...safeIntegration, config: sanitizedConfig, message: "Integración actualizada" } };
     } catch (error) {
         this.logger.error(`Error al actualizar integración Google Calendar ${integrationId}:`, error);
         const appError = toAppError(error);
         return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
     }
  }

  /**
   * Desactiva (eliminación lógica) una integración.
   * Requiere verificación de acceso del usuario a la integración.
   */
  async deleteIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
     try {
         const integration = await this.fetchIntegration(integrationId);
         if (!integration) return { status: 404, jsonBody: { error: "Integración no encontrada" } };
         const hasAccess = await this.verifyAccess(integration.agentId, userId); // VERIFICAR ACCESO DEL USUARIO
         if (!hasAccess) return { status: 403, jsonBody: { error: "No tienes permiso para eliminar esta integración" } };

         // Desactivar
         const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
         await tableClient.updateEntity({
             partitionKey: integration.agentId, rowKey: integrationId,
             isActive: false, status: IntegrationStatus.PENDING, // Cambiar estado a pendiente/inactivo
             updatedAt: Date.now()
         }, "Merge");

         // Revocar tokens (mejor esfuerzo)
         const config = integration.config as IntegrationGoogleCalendarConfig;
         if (config.accessToken) await this.revokeToken(config.accessToken);
         if (config.refreshToken) await this.revokeToken(config.refreshToken); // También revocar refresh token

         return { status: 200, jsonBody: { id: integrationId, message: "Integración eliminada (desactivada) con éxito" } };
     } catch (error) {
         this.logger.error(`Error al eliminar integración Google Calendar ${integrationId}:`, error);
         const appError = toAppError(error);
         return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
     }
  }


  // --- Métodos privados auxiliares ---

  /**
   * Refresca el token de acceso usando el refresh token.
   * Actualiza la entidad en Table Storage con los nuevos tokens.
   */
  private async refreshToken(integration: Integration): Promise<{
    success: boolean;
    accessToken?: string;
    expiresAt?: number;
    error?: string;
  }> {
    try {
      const config = integration.config as IntegrationGoogleCalendarConfig; // Asumir que ya está parseado
      if (!config.refreshToken) {
        this.logger.error(`No hay refresh token para la integración ${integration.id}. Requiere re-autenticación.`);
        // Actualizar estado a EXPIRADO o ERROR
        await this.updateIntegrationStatus(integration.id, integration.agentId, IntegrationStatus.EXPIRED);
        return { success: false, error: "No hay refresh token disponible. Requiere re-autenticación." };
      }

      const oauth2Client = new google.auth.OAuth2(this.clientId, this.clientSecret, this.redirectUri);
      oauth2Client.setCredentials({ refresh_token: config.refreshToken });

      this.logger.info(`Refrescando token para integración ${integration.id}...`);
      const { credentials } = await oauth2Client.refreshAccessToken();
      this.logger.info(`Token refrescado exitosamente para integración ${integration.id}.`);

      if (!credentials.access_token) {
        throw new Error("No se pudo obtener nuevo token de acceso al refrescar.");
      }

      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      const updatedConfig: IntegrationGoogleCalendarConfig = {
        ...config,
        accessToken: credentials.access_token,
        expiresAt: credentials.expiry_date || (Date.now() + 3600000), // Usar expiry_date si existe
        // Google a veces devuelve un nuevo refresh token, otras no. Preservar el antiguo si no viene uno nuevo.
        refreshToken: credentials.refresh_token || config.refreshToken
      };

      // Guardar la configuración actualizada (¡como JSON string!) y las nuevas credenciales
      await tableClient.updateEntity({
        partitionKey: integration.agentId,
        rowKey: integration.id,
        config: JSON.stringify(updatedConfig), // Convertir a JSON string
        updatedAt: Date.now(),
        credentials: updatedConfig.refreshToken || updatedConfig.accessToken, // Actualizar credenciales guardadas
        status: IntegrationStatus.ACTIVE // Asegurar que el estado vuelva a ser activo
      }, "Merge");

      this.logger.info(`Token actualizado y guardado para integración ${integration.id}`);
      return {
        success: true,
        accessToken: credentials.access_token,
        expiresAt: updatedConfig.expiresAt
      };
    } catch (error: any) {
      this.logger.error(`Error al actualizar token para integración ${integration.id}:`, error);
      // Si el error es 'invalid_grant', el refresh token es inválido o revocado.
      if (error.response?.data?.error === 'invalid_grant') {
          this.logger.error(`Refresh token inválido para integración ${integration.id}. Requiere re-autenticación.`);
          await this.updateIntegrationStatus(integration.id, integration.agentId, IntegrationStatus.EXPIRED);
          return { success: false, error: "Token de refresco inválido. Requiere re-autenticación." };
      }
      // Otros errores
      const errorMessage = error instanceof Error ? error.message : String(error);
      await this.updateIntegrationStatus(integration.id, integration.agentId, IntegrationStatus.ERROR); // Marcar como error
      return { success: false, error: errorMessage };
    }
  }

  /**
   * Busca una integración por su ID y parsea la configuración JSON.
   */
  private async fetchIntegration(integrationId: string): Promise<Integration | null> {
      try {
        const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
        const integrations = tableClient.listEntities({
          queryOptions: { filter: `RowKey eq '${integrationId}'` }
        });
        for await (const integration of integrations) {
           if (typeof integration.config === 'string') {
               try { integration.config = JSON.parse(integration.config); }
               catch (e) {
                   this.logger.warn(`Error parseando config JSON para integración ${integrationId}`, e);
                   integration.config = {};
               }
           } else if (integration.config === null || integration.config === undefined) {
                integration.config = {};
           }
          return integration as unknown as Integration;
        }
        return null;
      } catch (error) {
        this.logger.error(`Error al buscar integración ${integrationId}:`, error);
        return null;
      }
    }

  /**
   * Verifica si un usuario tiene acceso a un agente (propietario o rol activo).
   */
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

  /**
   * Revoca un token de Google (mejor esfuerzo).
   */
  private async revokeToken(token: string): Promise<void> {
    if (!token) return; // No hacer nada si no hay token
    try {
        const response = await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' });
        if (response.ok) {
            this.logger.info("Token revocado exitosamente (o ya era inválido).");
        } else {
            this.logger.warn(`Fallo al revocar token (status ${response.status}): ${await response.text()}`);
        }
    } catch (error) {
        this.logger.warn("Error de red al intentar revocar token:", error);
    }
  }

  /**
   * Actualiza el estado de una integración en Table Storage.
   */
   private async updateIntegrationStatus(integrationId: string, agentId: string, status: IntegrationStatus): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity({
        partitionKey: agentId,
        rowKey: integrationId,
        status,
        updatedAt: Date.now()
      }, "Merge");
      this.logger.info(`Estado de integración ${integrationId} actualizado a ${status}`);
    } catch (error: any) {
         // Ignorar 404 si la integración fue eliminada mientras tanto
         if (error.statusCode !== 404) {
            this.logger.error(`Error al actualizar estado de integración ${integrationId}:`, error);
         }
    }
  }

} // Fin de la clase GoogleCalendarHandler

