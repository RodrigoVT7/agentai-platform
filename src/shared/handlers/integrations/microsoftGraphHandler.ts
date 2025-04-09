// src/shared/handlers/integrations/microsoftGraphHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  Integration, 
  IntegrationType, 
  IntegrationStatus,
  IntegrationMicrosoftConfig 
} from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";

export class MicrosoftGraphHandler {
  private storageService: StorageService;
  private logger: Logger;
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
    
    // Obtener configuración de Microsoft OAuth
    this.clientId = process.env.MICROSOFT_CLIENT_ID || '';
    this.clientSecret = process.env.MICROSOFT_CLIENT_SECRET || '';
    this.redirectUri = process.env.MICROSOFT_REDIRECT_URI || '';
    
    if (!this.clientId || !this.clientSecret || !this.redirectUri) {
      this.logger.warn("Configuración de Microsoft OAuth incompleta");
    }
  }
  
  async getAuthUrl(agentId: string, userId: string, scopes: string): Promise<HttpResponseInit> {
    try {
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este agente" }
        };
      }
      
      // Generar estado para validación posterior (contiene userId y agentId)
      const state = Buffer.from(JSON.stringify({ userId, agentId })).toString('base64');
      
      // Construir URL de autorización
      const scopeArray = scopes.split(',');
      const encodedScopes = encodeURIComponent(scopeArray.join(' '));
      
      const authUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?` +
        `client_id=${this.clientId}` +
        `&response_type=code` +
        `&redirect_uri=${encodeURIComponent(this.redirectUri)}` +
        `&response_mode=query` +
        `&scope=${encodedScopes}` +
        `&state=${state}`;
      
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
      
      // Intercambiar código por tokens
      const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          code,
          redirect_uri: this.redirectUri,
          grant_type: 'authorization_code'
        }).toString()
      });
      
      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        throw createAppError(400, `Error al obtener token: ${errorText}`);
      }
      
      const tokens = await tokenResponse.json();
      
      if (!tokens.access_token) {
        throw createAppError(400, "No se pudo obtener token de acceso");
      }
      
      // Obtener información del usuario
      const graphResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
        headers: {
          'Authorization': `Bearer ${tokens.access_token}`
        }
      });
      
      if (!graphResponse.ok) {
        throw createAppError(400, "Error al obtener información del usuario");
      }
      
      const userInfo = await graphResponse.json();
      
      // Generar ID para la integración
      const integrationId = uuidv4();
      const now = Date.now();
      
      // Crear configuración de Microsoft Graph
      const config: IntegrationMicrosoftConfig = {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token || '',
        expiresAt: now + (tokens.expires_in * 1000),
        scope: tokens.scope || '',
        primaryCalendar: 'primary',
        primaryMailbox: userInfo.mail || userInfo.userPrincipalName
      };
      
      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name: "Microsoft 365",
        description: `Integración con Microsoft 365 (${userInfo.displayName})`,
        type: IntegrationType.CALENDAR, // Por defecto, puede actualizarse después
        provider: 'microsoft',
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
      
      // Verificar que la integración es de Microsoft
      if (integration.provider !== 'microsoft') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Microsoft Graph" }
        };
      }
      
      const config = integration.config as IntegrationMicrosoftConfig;
      
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
        config.accessToken = refreshResult.accessToken || config.accessToken;
        config.expiresAt = refreshResult.expiresAt || config.expiresAt;
      }
      
      // Construir parámetros de búsqueda
      const params = new URLSearchParams();
      
      if (options.startDate || options.endDate) {
        let filterParts = [];
        
        if (options.startDate) {
          filterParts.push(`start/dateTime ge '${new Date(options.startDate).toISOString()}'`);
        }
        
        if (options.endDate) {
          filterParts.push(`end/dateTime le '${new Date(options.endDate).toISOString()}'`);
        }
        
        if (filterParts.length > 0) {
          params.append('$filter', filterParts.join(' and '));
        }
      }
      
      // Ordenar por fecha de inicio
      params.append('$orderby', 'start/dateTime');
      
      // Obtener eventos a través de Microsoft Graph API
      const url = `https://graph.microsoft.com/v1.0/me/calendar/events?${params.toString()}`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${config.accessToken}`,
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        return {
          status: response.status,
          jsonBody: { 
            error: "Error al obtener eventos", 
            apiError: await response.text() 
          }
        };
      }
      
      const data = await response.json();
      
      // Formatear respuesta
      return {
        status: 200,
        jsonBody: {
          integrationId,
          events: data.value,
          period: {
            start: options.startDate,
            end: options.endDate
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
  
  async getMail(
    integrationId: string, 
    userId: string, 
    options: { folder: string, limit: number }
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
      
      // Verificar que la integración es de Microsoft
      if (integration.provider !== 'microsoft') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Microsoft Graph" }
        };
      }
      
      const config = integration.config as IntegrationMicrosoftConfig;
      
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
        config.accessToken = refreshResult.accessToken || config.accessToken;
        config.expiresAt = refreshResult.expiresAt || config.expiresAt;
      }
      
      // Construir parámetros de consulta
      const folderEndpoint = options.folder === 'inbox' 
        ? '/inbox' 
        : options.folder === 'sent' 
          ? '/sentItems' 
          : '';
      
      // Obtener emails a través de Microsoft Graph API
      const url = `https://graph.microsoft.com/v1.0/me/mailFolders${folderEndpoint}/messages?$top=${options.limit}&$orderby=receivedDateTime desc`;
      
      const response = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${config.accessToken}`,
          'Accept': 'application/json'
        }
      });
      
      if (!response.ok) {
        return {
          status: response.status,
          jsonBody: { 
            error: "Error al obtener emails", 
            apiError: await response.text() 
          }
        };
      }
      
      const data = await response.json();
      
      // Formatear respuesta
      return {
        status: 200,
        jsonBody: {
          integrationId,
          folder: options.folder,
          emails: data.value,
          count: data.value.length
        }
      };
    } catch (error) {
      this.logger.error(`Error al obtener emails para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener emails: ${errorMessage}` }
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
      const config = safeIntegration.config as IntegrationMicrosoftConfig;
      
      // Eliminar tokens del objeto de configuración para la respuesta
      const sanitizedConfig = {
        scope: config.scope,
        expiresAt: config.expiresAt,
        primaryCalendar: config.primaryCalendar,
        primaryMailbox: config.primaryMailbox,
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
        type = IntegrationType.CALENDAR,
        accessToken,
        refreshToken,
        expiresAt,
        scope,
        primaryCalendar,
        primaryMailbox
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
      
      // Crear configuración de Microsoft Graph
      const config: IntegrationMicrosoftConfig = {
        accessToken,
        refreshToken: refreshToken || '',
        expiresAt: expiresAt || (now + 3600000), // 1 hora por defecto
        scope: scope || 'https://graph.microsoft.com/.default',
        primaryCalendar: primaryCalendar || 'primary',
        primaryMailbox: primaryMailbox || ''
      };
      
      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name: name || "Microsoft 365",
        description: description || "Integración con Microsoft 365",
        type,
        provider: 'microsoft',
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
          message: "Integración con Microsoft 365 creada con éxito"
        }
      };
    } catch (error) {
      this.logger.error("Error al crear integración de Microsoft Graph:", error);
      
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
      
      // Verificar que la integración es de Microsoft
      if (integration.provider !== 'microsoft') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Microsoft Graph" }
        };
      }
      
      // Obtener configuración actual
      const config = integration.config as IntegrationMicrosoftConfig;
      
      // Actualizar campos de configuración
      const updatedConfig: IntegrationMicrosoftConfig = {
        ...config,
        primaryCalendar: data.primaryCalendar || config.primaryCalendar,
        primaryMailbox: data.primaryMailbox || config.primaryMailbox
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
          status: integration.status,
          message: "Integración de Microsoft Graph actualizada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar integración Microsoft Graph ${integrationId}:`, error);
      
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
      
      return {
        status: 200,
        jsonBody: {
          id: integrationId,
          message: "Integración de Microsoft Graph eliminada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar integración Microsoft Graph ${integrationId}:`, error);
      
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
      
      // Verificar que la integración es de Microsoft y está activa
      if (integration.provider !== 'microsoft') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Microsoft Graph" }
        };
      }
      
      const config = integration.config as IntegrationMicrosoftConfig;
      
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
        config.accessToken = refreshResult.accessToken || config.accessToken;
        config.expiresAt = refreshResult.expiresAt || config.expiresAt;
      }
      
      // Crear evento a través de Microsoft Graph API
      const url = 'https://graph.microsoft.com/v1.0/me/events';
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          subject: eventData.summary,
          body: {
            contentType: 'HTML',
            content: eventData.description || ''
          },
          start: eventData.start,
          end: eventData.end,
          location: eventData.location ? { displayName: eventData.location } : undefined,
          attendees: eventData.attendees || []
        })
      });
      
      if (!response.ok) {
        return {
          status: response.status,
          jsonBody: { 
            error: "Error al crear evento", 
            apiError: await response.text() 
          }
        };
      }
      
      const result = await response.json();
      
      return {
        status: 201,
        jsonBody: {
          id: result.id,
          subject: result.subject,
          webLink: result.webLink,
          createdDateTime: result.createdDateTime,
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
      
      // Verificar que la integración es de Microsoft y está activa
      if (integration.provider !== 'microsoft') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Microsoft Graph" }
        };
      }
      
      const config = integration.config as IntegrationMicrosoftConfig;
      
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
        config.accessToken = refreshResult.accessToken || config.accessToken;
        config.expiresAt = refreshResult.expiresAt || config.expiresAt;
      }
      
      // Actualizar evento a través de Microsoft Graph API
      const url = `https://graph.microsoft.com/v1.0/me/events/${eventId}`;
      
      // Preparar datos para la actualización
      const eventUpdateData: Record<string, any> = {};
      
      if (eventData.summary) eventUpdateData.subject = eventData.summary;
      if (eventData.description) {
        eventUpdateData.body = {
          contentType: 'HTML',
          content: eventData.description
        };
      }
      if (eventData.start) eventUpdateData.start = eventData.start;
      if (eventData.end) eventUpdateData.end = eventData.end;
      if (eventData.location) {
        eventUpdateData.location = { displayName: eventData.location };
      }
      if (eventData.attendees) eventUpdateData.attendees = eventData.attendees;
      
      const response = await fetch(url, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(eventUpdateData)
      });
      
      if (!response.ok) {
        return {
          status: response.status,
          jsonBody: { 
            error: "Error al actualizar evento", 
            apiError: await response.text() 
          }
        };
      }
      
      return {
        status: 200,
        jsonBody: {
          id: eventId,
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
      
      // Verificar que la integración es de Microsoft y está activa
      if (integration.provider !== 'microsoft') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Microsoft Graph" }
        };
      }
      
      const config = integration.config as IntegrationMicrosoftConfig;
      
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
        config.accessToken = refreshResult.accessToken || config.accessToken;
        config.expiresAt = refreshResult.expiresAt || config.expiresAt;
      }
      
      // Eliminar evento a través de Microsoft Graph API
      const url = `https://graph.microsoft.com/v1.0/me/events/${eventId}`;
      
      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${config.accessToken}`
        }
      });
      
      if (!response.ok) {
        return {
          status: response.status,
          jsonBody: { 
            error: "Error al eliminar evento", 
            apiError: await response.text() 
          }
        };
      }
      
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
  
  async sendMail(integrationId: string, mailData: any, userId: string): Promise<HttpResponseInit> {
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
      
      // Verificar que la integración es de Microsoft y está activa
      if (integration.provider !== 'microsoft') {
        return {
          status: 400,
          jsonBody: { error: "La integración no es de Microsoft Graph" }
        };
      }
      
      const config = integration.config as IntegrationMicrosoftConfig;
      
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
        config.accessToken = refreshResult.accessToken || config.accessToken;
        config.expiresAt = refreshResult.expiresAt || config.expiresAt;
      }
      
      // Enviar email a través de Microsoft Graph API
      const url = 'https://graph.microsoft.com/v1.0/me/sendMail';
      
      // Preparar datos para el correo
      const recipients = Array.isArray(mailData.to) 
        ? mailData.to.map((email: string) => ({ emailAddress: { address: email } }))
        : [{ emailAddress: { address: mailData.to } }];
      
      const ccRecipients = mailData.cc 
        ? (Array.isArray(mailData.cc)
          ? mailData.cc.map((email: string) => ({ emailAddress: { address: email } }))
          : [{ emailAddress: { address: mailData.cc } }])
        : [];
      
      const mailContent = {
        message: {
          subject: mailData.subject,
          body: {
            contentType: mailData.isHtml ? 'HTML' : 'Text',
            content: mailData.body
          },
          toRecipients: recipients,
          ccRecipients
        },
        saveToSentItems: true
      };
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(mailContent)
      });
      
      if (!response.ok) {
        return {
          status: response.status,
          jsonBody: { 
            error: "Error al enviar email", 
            apiError: await response.text() 
          }
        };
      }
      
      return {
        status: 200,
        jsonBody: {
          success: true,
          message: "Email enviado con éxito",
          to: mailData.to,
          subject: mailData.subject
        }
      };
    } catch (error) {
      this.logger.error(`Error al enviar email para integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al enviar email: ${errorMessage}` }
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
      const config = integration.config as IntegrationMicrosoftConfig;
      
      // Verificar que tenemos refresh token
      if (!config.refreshToken) {
        return { 
          success: false, 
          error: "No hay refresh token disponible" 
        };
      }
      
      // Solicitar nuevo token
      const tokenResponse = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: config.refreshToken,
          grant_type: 'refresh_token'
        }).toString()
      });
      
      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        return { 
          success: false, 
          error: `Error al refrescar token: ${errorText}` 
        };
      }
      
      const tokens = await tokenResponse.json();
      
      if (!tokens.access_token) {
        return { 
          success: false, 
          error: "No se pudo obtener nuevo token de acceso" 
        };
      }
      
      // Actualizar tokens en la integración
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      const expiresAt = Date.now() + (tokens.expires_in * 1000);
      
      const updatedConfig: IntegrationMicrosoftConfig = {
        ...config,
        accessToken: tokens.access_token,
        expiresAt,
        // Si se devuelve nuevo refresh_token, actualizarlo
        refreshToken: tokens.refresh_token || config.refreshToken
      };
      
      await tableClient.updateEntity({
        partitionKey: integration.agentId,
        rowKey: integration.id,
        config: updatedConfig,
        updatedAt: Date.now()
      }, "Merge");
      
      return {
        success: true,
        accessToken: tokens.access_token,
        expiresAt
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
}