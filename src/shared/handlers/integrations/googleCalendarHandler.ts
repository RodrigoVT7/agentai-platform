// src/shared/handlers/integrations/googleCalendarHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  Integration, 
  IntegrationType, 
  IntegrationStatus,
  IntegrationGoogleCalendarConfig 
} from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";
import { google } from "googleapis";

export class GoogleCalendarHandler {
  private storageService: StorageService;
  private logger: Logger;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
    
    // Obtener configuración de Google OAuth
    this.clientId = process.env.GOOGLE_CLIENT_ID || '';
    this.clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    this.redirectUri = process.env.GOOGLE_REDIRECT_URI || '';
    
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      this.logger.warn("Configuración de Google OAuth incompleta");
    }
  }
  
  async getAuthUrl(agentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este agente" }
        };
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Definir ámbitos
      const scopes = [
        'https://www.googleapis.com/auth/calendar',
        'https://www.googleapis.com/auth/calendar.events'
      ];
      
      // Generar estado para validación posterior (contiene userId y agentId)
      const state = Buffer.from(JSON.stringify({ userId, agentId })).toString('base64');
      
      // Generar URL de autorización
      const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        state,
        prompt: 'consent' // Forzar obtención de refresh_token
      });
      
      return {
        status: 200,
        jsonBody: {
          authUrl,
          message: "URL de autorización generada con éxito"
        }
      };
    } catch (error) {
      this.logger.error("Error al generar URL de autorización:", error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al generar URL de autorización: ${errorMessage}` }
      };
    }
  }
  
  async processAuthCode(code: string, userId: string, agentId: string): Promise<any> {
    try {
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para acceder a este agente");
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Intercambiar código por tokens
      const { tokens } = await oauth2Client.getToken(code);
      
      if (!tokens.access_token) {
        throw createAppError(400, "No se pudo obtener token de acceso");
      }
      
      // Establecer tokens en el cliente
      oauth2Client.setCredentials(tokens);
      
      // Obtener información del servicio Calendar
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // Obtener lista de calendarios para verificar acceso
      const calendarResponse = await calendar.calendarList.list();
      
      if (!calendarResponse.data.items || calendarResponse.data.items.length === 0) {
        throw createAppError(400, "No se encontraron calendarios asociados");
      }
      
      // Usar el calendario principal por defecto
      const primaryCalendar = calendarResponse.data.items.find(cal => cal.primary) || calendarResponse.data.items[0];
      
      // Generar ID para la integración
      const integrationId = uuidv4();
      const now = Date.now();
      
      // Crear configuración de Google Calendar
      const config: IntegrationGoogleCalendarConfig = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: tokens.expiry_date || 0,
        scope: Array.isArray(tokens.scope) ? tokens.scope.join(' ') : tokens.scope || '',
        calendarId: primaryCalendar.id || 'primary'
      };
      
      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name: "Google Calendar",
        description: `Integración con Google Calendar (${primaryCalendar.summary})`,
        type: IntegrationType.CALENDAR,
        provider: 'google',
        config,
        credentials: tokens.refresh_token || tokens.access_token || '',
        status: IntegrationStatus.ACTIVE,
        createdBy: userId,
        createdAt: now,
        isActive: true
      };
      
      // Guardar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: integrationId,
        ...integration
      });
      
      return {
        integrationId,
        success: true
      };
    } catch (error) {
      this.logger.error("Error al procesar código de autorización:", error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, `Error al procesar autorización: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  async getEvents(
    integrationId: string, 
    userId: string, 
    options: { startDate?: string, endDate?: string }
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo Calendar y está activa
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Google Calendar" }
        };
      }
      
      const config = integration.config as IntegrationGoogleCalendarConfig;
      
      // Verificar si el token ha expirado y actualizarlo si es necesario
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) {
          return {
            status: 401,
            jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error }
          };
        }
        // Actualizar config con nuevos tokens
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Establecer token de acceso
      oauth2Client.setCredentials({
        access_token: config.accessToken
      });
      
      // Crear cliente de Calendar
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // Parsear fechas
      const timeMin = options.startDate ? new Date(options.startDate).toISOString() : new Date().toISOString();
      const timeMax = options.endDate ? new Date(options.endDate).toISOString() : 
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(); // +30 días por defecto
      
      // Obtener eventos
      const eventsResponse = await calendar.events.list({
        calendarId: config.calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
        orderBy: 'startTime'
      });
      
      const events = eventsResponse.data.items || [];
      
      // Formatear eventos
      const formattedEvents = events.map(event => ({
        id: event.id,
        summary: event.summary,
        description: event.description,
        location: event.location,
        start: event.start,
        end: event.end,
        status: event.status,
        creator: event.creator,
        organizer: event.organizer,
        attendees: event.attendees,
        created: event.created,
        updated: event.updated
      }));
      
      return {
        status: 200,
        jsonBody: {
          integrationId,
          calendarId: config.calendarId,
          events: formattedEvents,
          period: {
            start: timeMin,
            end: timeMax
          }
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener eventos para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener eventos: ${errorMessage}` }
      };
    }
  }
  
  async listCalendars(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo Calendar y está activa
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Google Calendar" }
        };
      }
      
      const config = integration.config as IntegrationGoogleCalendarConfig;
      
      // Verificar si el token ha expirado y actualizarlo si es necesario
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) {
          return {
            status: 401,
            jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error }
          };
        }
        // Actualizar config con nuevos tokens
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Establecer token de acceso
      oauth2Client.setCredentials({
        access_token: config.accessToken
      });
      
      // Crear cliente de Calendar
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // Obtener lista de calendarios
      const calendarResponse = await calendar.calendarList.list();
      
      const calendars = calendarResponse.data.items || [];
      
      // Formatear calendarios
      const formattedCalendars = calendars.map(cal => ({
        id: cal.id,
        summary: cal.summary,
        description: cal.description,
        primary: cal.primary || false,
        accessRole: cal.accessRole,
        backgroundColor: cal.backgroundColor
      }));
      
      return {
        status: 200,
        jsonBody: {
          integrationId,
          calendars: formattedCalendars,
          currentCalendarId: config.calendarId
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener calendarios para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener calendarios: ${errorMessage}` }
      };
    }
  }
  
  async getIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a esta integración" }
        };
      }
      
      // No devolver credenciales sensibles
      const { credentials, ...safeIntegration } = integration;
      const config = safeIntegration.config as IntegrationGoogleCalendarConfig;
      
      // Eliminar tokens del objeto de configuración para la respuesta
      const sanitizedConfig = {
        calendarId: config.calendarId,
        scope: config.scope,
        expiresAt: config.expiresAt,
        hasRefreshToken: !!config.refreshToken
      };
      
      return {
        status: 200,
        jsonBody: {
          ...safeIntegration,
          config: sanitizedConfig
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener integración: ${errorMessage}` }
      };
    }
  }
  
  async createIntegration(data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const { 
        agentId, 
        name, 
        description, 
        accessToken,
        refreshToken,
        expiresAt,
        calendarId,
        scope
      } = data;
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar este agente" }
        };
      }
      
      // Verificar que tenemos tokens necesarios
      if (!accessToken) {
        return {
          status: 400,
          jsonBody: { error: "Se requiere token de acceso" }
        };
      }
      
      // Generar ID para la integración
      const integrationId = uuidv4();
      const now = Date.now();
      
      // Crear configuración de Google Calendar
      const config: IntegrationGoogleCalendarConfig = {
        accessToken,
        refreshToken: refreshToken || '',
        expiresAt: expiresAt || (now + 3600000), // 1 hora por defecto
        scope: scope || 'https://www.googleapis.com/auth/calendar',
        calendarId: calendarId || 'primary'
      };
      
      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name: name || "Google Calendar",
        description: description || "Integración con Google Calendar",
        type: IntegrationType.CALENDAR,
        provider: 'google',
        config,
        credentials: refreshToken || accessToken,
        status: IntegrationStatus.ACTIVE,
        createdBy: userId,
        createdAt: now,
        isActive: true
      };
      
      // Guardar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: integrationId,
        ...integration
      });
      
      return {
        status: 201,
        jsonBody: {
          id: integrationId,
          name: integration.name,
          status: IntegrationStatus.ACTIVE,
          message: "Integración con Google Calendar creada con éxito"
        }
      };
    } catch (error) {
      this.logger.error("Error al crear integración de Google Calendar:", error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al crear integración: ${errorMessage}` }
      };
    }
  }
  
  async updateIntegration(integrationId: string, data: any, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo Calendar
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Google Calendar" }
        };
      }
      
      // Obtener configuración actual
      const config = integration.config as IntegrationGoogleCalendarConfig;
      
      // Actualizar campos de configuración
      const updatedConfig: IntegrationGoogleCalendarConfig = {
        ...config,
        calendarId: data.calendarId || config.calendarId
      };
      
      // Si se proporcionan nuevos tokens, actualizarlos
      if (data.accessToken) {
        updatedConfig.accessToken = data.accessToken;
        updatedConfig.expiresAt = data.expiresAt || (Date.now() + 3600000);
      }
      
      if (data.refreshToken) {
        updatedConfig.refreshToken = data.refreshToken;
      }
      
      // Preparar datos para actualización
      const updateData: any = {
        partitionKey: integration.agentId,
        rowKey: integrationId,
        config: updatedConfig,
        updatedAt: Date.now()
      };
      
      // Actualizar nombre si se proporciona
      if (data.name) {
        updateData.name = data.name;
      }
      
      // Actualizar descripción si se proporciona
      if (data.description) {
        updateData.description = data.description;
      }
      
      // Si se proporciona nuevo token, actualizar credenciales
      if (data.refreshToken || data.accessToken) {
        updateData.credentials = data.refreshToken || data.accessToken;
      }
      
      // Actualizar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity(updateData, "Merge");
      
      return {
        status: 200,
        jsonBody: {
          id: integrationId,
          name: data.name || integration.name,
          calendarId: updatedConfig.calendarId,
          message: "Integración de Google Calendar actualizada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar integración Google Calendar ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al actualizar integración: ${errorMessage}` }
      };
    }
  }
  
  async deleteIntegration(integrationId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para eliminar esta integración" }
        };
      }
      
      // Realizar eliminación lógica
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity({
        partitionKey: integration.agentId,
        rowKey: integrationId,
        isActive: false,
        updatedAt: Date.now()
      }, "Merge");
      
      // También revocar tokens si es posible
      try {
        const config = integration.config as IntegrationGoogleCalendarConfig;
        if (config.accessToken) {
          await this.revokeToken(config.accessToken);
        }
      } catch (revokeError) {
        this.logger.warn(`Error al revocar token para integración ${integrationId}:`, revokeError);
        // Continuar con la eliminación aunque falle la revocación
      }
      
      return {
        status: 200,
        jsonBody: {
          id: integrationId,
          message: "Integración de Google Calendar eliminada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar integración Google Calendar ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al eliminar integración: ${errorMessage}` }
      };
    }
  }
  
  async createEvent(integrationId: string, eventData: any, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo Calendar y está activa
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Google Calendar" }
        };
      }
      
      const config = integration.config as IntegrationGoogleCalendarConfig;
      
      // Verificar si el token ha expirado y actualizarlo si es necesario
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) {
          return {
            status: 401,
            jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error }
          };
        }
        // Actualizar config con nuevos tokens
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Establecer token de acceso
      oauth2Client.setCredentials({
        access_token: config.accessToken
      });
      
      // Crear cliente de Calendar
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // Preparar evento para Google Calendar
      const event = {
        summary: eventData.summary,
        location: eventData.location,
        description: eventData.description,
        start: eventData.start,
        end: eventData.end,
        attendees: eventData.attendees,
        reminders: eventData.reminders
      };
      
      // Crear evento
      const response = await calendar.events.insert({
        calendarId: config.calendarId,
        requestBody: event
      });
      
      return {
        status: 201,
        jsonBody: {
          id: response.data.id,
          summary: response.data.summary,
          htmlLink: response.data.htmlLink,
          created: response.data.created,
          message: "Evento creado con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al crear evento para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al crear evento: ${errorMessage}` }
      };
    }
  }
  
  async updateEvent(
    integrationId: string, 
    eventId: string, 
    eventData: any, 
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo Calendar y está activa
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Google Calendar" }
        };
      }
      
      const config = integration.config as IntegrationGoogleCalendarConfig;
      
      // Verificar si el token ha expirado y actualizarlo si es necesario
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) {
          return {
            status: 401,
            jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error }
          };
        }
        // Actualizar config con nuevos tokens
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Establecer token de acceso
      oauth2Client.setCredentials({
        access_token: config.accessToken
      });
      
      // Crear cliente de Calendar
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // Obtener evento actual
      const currentEvent = await calendar.events.get({
        calendarId: config.calendarId,
        eventId
      });
      
      // Preparar evento actualizado
      const event = {
        ...currentEvent.data,
        summary: eventData.summary || currentEvent.data.summary,
        location: eventData.location || currentEvent.data.location,
        description: eventData.description || currentEvent.data.description,
        start: eventData.start || currentEvent.data.start,
        end: eventData.end || currentEvent.data.end,
        attendees: eventData.attendees || currentEvent.data.attendees,
        reminders: eventData.reminders || currentEvent.data.reminders
      };
      
      // Actualizar evento
      const response = await calendar.events.update({
        calendarId: config.calendarId,
        eventId,
        requestBody: event
      });
      
      return {
        status: 200,
        jsonBody: {
          id: response.data.id,
          summary: response.data.summary,
          htmlLink: response.data.htmlLink,
          updated: response.data.updated,
          message: "Evento actualizado con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar evento para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al actualizar evento: ${errorMessage}` }
      };
    }
  }
  
  async deleteEvent(
    integrationId: string, 
    eventId: string, 
    userId: string
  ): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Verificar que la integración es de tipo Calendar y está activa
      if (integration.type !== IntegrationType.CALENDAR || integration.provider !== 'google') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Google Calendar" }
        };
      }
      
      const config = integration.config as IntegrationGoogleCalendarConfig;
      
      // Verificar si el token ha expirado y actualizarlo si es necesario
      if (config.expiresAt < Date.now()) {
        const refreshResult = await this.refreshToken(integration);
        if (!refreshResult.success) {
          return {
            status: 401,
            jsonBody: { error: "Error al actualizar token de acceso", details: refreshResult.error }
          };
        }
        // Actualizar config con nuevos tokens
        config.accessToken = refreshResult.accessToken;
        config.expiresAt = refreshResult.expiresAt;
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Establecer token de acceso
      oauth2Client.setCredentials({
        access_token: config.accessToken
      });
      
      // Crear cliente de Calendar
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      
      // Eliminar evento
      await calendar.events.delete({
        calendarId: config.calendarId,
        eventId
      });
      
      return {
        status: 200,
        jsonBody: {
          id: eventId,
          message: "Evento eliminado con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar evento para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al eliminar evento: ${errorMessage}` }
      };
    }
  }
  
  // Métodos auxiliares
  
  private async fetchIntegration(integrationId: string): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      // Buscar en todas las particiones
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      
      for await (const integration of integrations) {
        return integration as unknown as Integration;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al buscar integración ${integrationId}:`, error);
      return null;
    }
  }
  
  private async verifyAccess(agentId: string, userId: string): Promise<boolean> {
    try {
      // Verificar si el usuario es propietario del agente
      const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await agentsTable.getEntity('agent', agentId);
        
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        return false;
      }
      
      // Verificar si el usuario tiene algún rol en el agente
      const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = rolesTable.listEntities({
        queryOptions: { filter: `agentId eq '${agentId}' and userId eq '${userId}' and isActive eq true` }
      });
      
      for await (const role of roles) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar acceso al agente ${agentId}:`, error);
      return false;
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
      
      // Verificar que tenemos refresh token
      if (!config.refreshToken) {
        return { 
          success: false, 
          error: "No hay refresh token disponible" 
        };
      }
      
      // Crear cliente OAuth
      const oauth2Client = new google.auth.OAuth2(
        this.clientId,
        this.clientSecret,
        this.redirectUri
      );
      
      // Establecer refresh token
      oauth2Client.setCredentials({
        refresh_token: config.refreshToken
      });
      
      // Obtener nuevo access token
      const { credentials } = await oauth2Client.refreshAccessToken();
      
      if (!credentials.access_token) {
        return { 
          success: false, 
          error: "No se pudo obtener nuevo token de acceso" 
        };
      }
      
      // Actualizar tokens en la integración
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      const updatedConfig: IntegrationGoogleCalendarConfig = {
        ...config,
        accessToken: credentials.access_token,
        expiresAt: credentials.expiry_date || (Date.now() + 3600000)
      };
      
      await tableClient.updateEntity({
        partitionKey: integration.agentId,
        rowKey: integration.id,
        config: updatedConfig,
        updatedAt: Date.now()
      }, "Merge");
      
      return {
        success: true,
        accessToken: credentials.access_token,
        expiresAt: credentials.expiry_date || (Date.now() + 3600000)
      };
    } catch (error) {
      this.logger.error(`Error al actualizar token para integración ${integration.id}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { 
        success: false, 
        error: errorMessage 
      };
    }
  }
  
  private async revokeToken(token: string): Promise<void> {
    try {
      // Revocar token en Google
      await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
    } catch (error) {
      this.logger.error("Error al revocar token:", error);
      throw error;
    }
  }
}