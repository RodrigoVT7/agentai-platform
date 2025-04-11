// src/shared/handlers/integrations/integrationExecutorHandler.ts
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Integration, IntegrationStatus, IntegrationAction } from "../../models/integration.model";
import fetch from "node-fetch";

export class IntegrationExecutorHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async execute(data: IntegrationAction, userId: string): Promise<any> {
    try {
      const { integrationId, action, parameters, async = false } = data;
      
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        throw createAppError(404, "Integración no encontrada");
      }
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para ejecutar esta integración");
      }
      
      // Verificar estado de la integración
      if (integration.status !== IntegrationStatus.ACTIVE) {
        throw createAppError(400, `La integración no está activa (estado: ${integration.status})`);
      }
      
      // Si es asíncrono, encolar para procesamiento
      if (async) {
        // Agregar userId a los datos para verificar permisos al procesar
        const queueMessage = {
          ...data,
          userId
        };
        
        const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.INTEGRATION);
        await queueClient.sendMessage(Buffer.from(JSON.stringify(queueMessage)).toString('base64'));
        
        // Registrar la acción
        await this.logIntegrationAction(integration.agentId, integrationId, action, 'queued', userId);
        
        return {
          status: 202,
          message: "Solicitud encolada para procesamiento asíncrono",
          requestId: data.conversationId || Date.now().toString()
        };
      }
      
      // Procesamiento síncrono
      const result = await this.executeIntegrationAction(integration, action, parameters, userId);
      
      // Registrar la acción
      await this.logIntegrationAction(
        integration.agentId, 
        integrationId, 
        action, 
        result.success ? 'success' : 'error', 
        userId
      );
      
      return result;
    } catch (error) {
      this.logger.error("Error al ejecutar acción de integración:", error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, "Error al ejecutar acción de integración");
    }
  }
  
  async executeFromQueue(message: any): Promise<void> {
    try {
      const { integrationId, action, parameters, userId } = message;
      
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        throw new Error(`Integración no encontrada: ${integrationId}`);
      }
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        throw new Error(`Usuario ${userId} no tiene permisos para integración ${integrationId}`);
      }
      
      // Ejecutar la acción
      const result = await this.executeIntegrationAction(integration, action, parameters, userId);
      
      // Registrar resultado
      await this.logIntegrationAction(
        integration.agentId, 
        integrationId, 
        action, 
        result.success ? 'success' : 'error', 
        userId
      );
      
      // Si hay callback URL, enviar resultado
      if (message.callbackUrl) {
        try {
          await fetch(message.callbackUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              integrationId,
              action,
              requestId: message.conversationId || message.messageId,
              result
            })
          });
        } catch (callbackError) {
          this.logger.error("Error al enviar resultado a callback URL:", callbackError);
        }
      }
    } catch (error) {
      this.logger.error("Error al procesar mensaje de cola:", error);
    }
  }
  
  private async executeIntegrationAction(
    integration: Integration, 
    action: string, 
    parameters: Record<string, any>, 
    userId: string
  ): Promise<any> {
    try {
      const { type, provider } = integration;
      
      // Determinar qué manejador específico usar según tipo y proveedor
      switch (`${type}:${provider}`) {
        case 'calendar:google':
          return await this.executeGoogleCalendarAction(integration, action, parameters);
          
        case 'messaging:whatsapp':
          return await this.executeWhatsAppAction(integration, action, parameters);
          
        case 'calendar:microsoft':
          return await this.executeMicrosoftGraphAction(integration, action, parameters, 'calendar');
          
        case 'email:microsoft':
          return await this.executeMicrosoftGraphAction(integration, action, parameters, 'email');
          
        case 'erp:generic':
        case 'erp:sap':
        case 'erp:dynamics':
        case 'erp:odoo':
          return await this.executeERPAction(integration, action, parameters);
          
        default:
          throw createAppError(400, `Tipo de integración no soportada: ${type}:${provider}`);
      }
    } catch (error) {
      this.logger.error(`Error al ejecutar acción ${action}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        return {
          success: false,
          error: typeof error === 'object' && 'message' in error 
            ? String(error.message) 
            : "Error al ejecutar acción",
          details: typeof error === 'object' && 'details' in error 
            ? error.details 
            : undefined
        };
      }
      
      return {
        success: false,
        error: error instanceof Error ? error.message : "Error desconocido al ejecutar acción"
      };
    }
  }
  
  private async executeGoogleCalendarAction(
    integration: Integration, 
    action: string, 
    parameters: Record<string, any>
  ): Promise<any> {
    // Aquí se delegaría a GoogleCalendarHandler
    // Ejemplos de acciones: getEvents, createEvent, updateEvent, deleteEvent
    
    this.logger.info(`Ejecutando acción de Google Calendar: ${action}`);
    
    // Esta es una implementación simplificada
    // En producción, se delegaría en un handler específico
    
    return {
      success: true,
      action,
      result: {
        message: `Acción ${action} ejecutada con éxito en Google Calendar (simulación)`,
        parameters
      }
    };
  }
  
  private async executeWhatsAppAction(
    integration: Integration, 
    action: string, 
    parameters: Record<string, any>
  ): Promise<any> {
    // Aquí se delegaría a WhatsAppIntegrationHandler
    // Ejemplos de acciones: sendMessage, sendTemplate
    
    this.logger.info(`Ejecutando acción de WhatsApp: ${action}`);
    
    return {
      success: true,
      action,
      result: {
        message: `Acción ${action} ejecutada con éxito en WhatsApp (simulación)`,
        parameters
      }
    };
  }
  
  private async executeMicrosoftGraphAction(
    integration: Integration, 
    action: string, 
    parameters: Record<string, any>,
    service: string
  ): Promise<any> {
    // Aquí se delegaría a MicrosoftGraphHandler
    
    this.logger.info(`Ejecutando acción de Microsoft Graph (${service}): ${action}`);
    
    return {
      success: true,
      action,
      service,
      result: {
        message: `Acción ${action} ejecutada con éxito en Microsoft ${service} (simulación)`,
        parameters
      }
    };
  }
  
  private async executeERPAction(
    integration: Integration, 
    action: string, 
    parameters: Record<string, any>
  ): Promise<any> {
    // Aquí se delegaría a ERPConnectorHandler
    
    this.logger.info(`Ejecutando acción de ERP: ${action}`);
    
    return {
      success: true,
      action,
      result: {
        message: `Acción ${action} ejecutada con éxito en ERP (simulación)`,
        parameters
      }
    };
  }
  
  private async logIntegrationAction(
    agentId: string,
    integrationId: string,
    action: string,
    status: string,
    userId: string
  ): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATION_LOGS);
      
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: `${Date.now()}_${integrationId}`,
        integrationId,
        action,
        status,
        executedBy: userId,
        timestamp: Date.now()
      });
    } catch (error) {
      this.logger.error("Error al registrar acción de integración:", error);
    }
  }
  
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
}