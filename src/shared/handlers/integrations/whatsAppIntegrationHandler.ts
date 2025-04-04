// src/shared/handlers/integrations/whatsAppIntegrationHandler.ts
import { v4 as uuidv4 } from "uuid";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES, STORAGE_QUEUES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { 
  Integration, 
  IntegrationType, 
  IntegrationStatus,
  IntegrationWhatsAppConfig
} from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions";
import fetch from "node-fetch";

export class WhatsAppIntegrationHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async getStatus(integrationId: string, userId: string): Promise<HttpResponseInit> {
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
      
      // Verificar estado actual con la API de WhatsApp
      try {
        const config = integration.config as IntegrationWhatsAppConfig;
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${config.phoneNumberId}?fields=verified_name,quality_rating,display_phone_number`,
          {
            headers: {
              Authorization: `Bearer ${config.accessToken}`
            }
          }
        );
        
        if (!response.ok) {
          // Si hay problema con la API, actualizar estado de la integración
          await this.updateIntegrationStatus(integrationId, integration.agentId, IntegrationStatus.ERROR);
          
          return {
            status: 200,
            jsonBody: {
              id: integrationId,
              status: IntegrationStatus.ERROR,
              message: "Error al conectar con la API de WhatsApp",
              lastCheck: Date.now()
            }
          };
        }
        
        const data = await response.json();
        
        // Si todo está bien, actualizar estado si es necesario
        if (integration.status !== IntegrationStatus.ACTIVE) {
          await this.updateIntegrationStatus(integrationId, integration.agentId, IntegrationStatus.ACTIVE);
        }
        
        return {
          status: 200,
          jsonBody: {
            id: integrationId,
            status: IntegrationStatus.ACTIVE,
            phone: data.display_phone_number,
            name: data.verified_name,
            qualityRating: data.quality_rating,
            lastCheck: Date.now()
          }
        };
      } catch (error) {
        this.logger.error(`Error al verificar estado de WhatsApp para ${integrationId}:`, error);
        
        // Actualizar estado a ERROR
        await this.updateIntegrationStatus(integrationId, integration.agentId, IntegrationStatus.ERROR);
        
        return {
          status: 200,
          jsonBody: {
            id: integrationId,
            status: IntegrationStatus.ERROR,
            message: "Error al verificar estado",
            lastCheck: Date.now()
          }
        };
      }
    } catch (error) {
      this.logger.error(`Error al obtener estado de integración ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al obtener estado: ${errorMessage}` }
      };
    }
  }
  
  async listNumbers(agentId: string, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para acceder a este agente" }
        };
      }
      
      // Buscar integraciones de tipo WhatsApp para este agente
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      const whatsappIntegrations: any[] = [];
      const integrations = await tableClient.listEntities({
        queryOptions: { 
          filter: `PartitionKey eq '${agentId}' and type eq '${IntegrationType.MESSAGING}' and provider eq 'whatsapp' and isActive eq true` 
        }
      });
      
      for await (const integration of integrations) {
        const config = typeof integration.config === 'string' 
          ? JSON.parse(integration.config) 
          : integration.config;
        
        whatsappIntegrations.push({
          id: integration.id,
          name: integration.name,
          status: integration.status,
          phoneNumber: config.phoneNumber,
          displayName: config.displayName
        });
      }
      
      return {
        status: 200,
        jsonBody: {
          agentId,
          integrations: whatsappIntegrations
        }
      };
    } catch (error) {
      this.logger.error(`Error al listar números de WhatsApp para agente ${agentId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al listar números: ${errorMessage}` }
      };
    }
  }
  
  async setupIntegration(data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const { 
        agentId, 
        name, 
        phoneNumberId, 
        businessAccountId, 
        accessToken, 
        webhookVerifyToken,
        phoneNumber,
        displayName
      } = data;
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar este agente" }
        };
      }
      
      // Validar conexión con WhatsApp
      try {
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${phoneNumberId}?fields=verified_name,display_phone_number`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`
            }
          }
        );
        
        if (!response.ok) {
          return {
            status: 400,
            jsonBody: { 
              error: "Credenciales inválidas para WhatsApp", 
              apiError: await response.text() 
            }
          };
        }
      } catch (error) {
        return {
          status: 400,
          jsonBody: { 
            error: "Error al verificar credenciales de WhatsApp",
            details: error instanceof Error ? error.message : String(error)
          }
        };
      }
      
      // Generar ID para la integración
      const integrationId = uuidv4();
      const now = Date.now();
      
      // Crear configuración de WhatsApp
      const config: IntegrationWhatsAppConfig = {
        phoneNumberId,
        businessAccountId,
        accessToken,
        webhookVerifyToken,
        phoneNumber,
        displayName: displayName || name
      };
      
      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name,
        description: `Integración con WhatsApp para el número ${phoneNumber}`,
        type: IntegrationType.MESSAGING,
        provider: 'whatsapp',
        config,
        credentials: accessToken, // En producción, encriptar
        status: IntegrationStatus.CONFIGURED,
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
          name,
          phoneNumber,
          status: IntegrationStatus.CONFIGURED,
          message: "Integración de WhatsApp creada con éxito"
        }
      };
    } catch (error) {
      this.logger.error("Error al configurar integración de WhatsApp:", error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al configurar integración: ${errorMessage}` }
      };
    }
  }
  
  async sendMessage(data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const { integrationId, to, type, text, template, mediaId } = data;
      
      // Verificar si la integración existe
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      // Verificar acceso
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para usar esta integración" }
        };
      }
      
      // Obtener configuración
      const config = integration.config as IntegrationWhatsAppConfig;
      
      // Preparar mensaje según tipo
      let payload: any;
      
      switch (type) {
        case 'text':
          payload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "text",
            text: { body: text.body }
          };
          break;
          
        case 'template':
          payload = {
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to,
            type: "template",
            template: {
              name: template.name,
              language: { code: template.language || "es" },
              components: template.components || []
            }
          };
          break;
          
        // Otros tipos (image, document, etc.) pueden implementarse según necesidad
          
        default:
          return {
            status: 400,
            jsonBody: { error: `Tipo de mensaje no soportado: ${type}` }
          };
      }
      
      // Enviar mensaje a WhatsApp
      try {
        const response = await fetch(
          `https://graph.facebook.com/v18.0/${config.phoneNumberId}/messages`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${config.accessToken}`
            },
            body: JSON.stringify(payload)
          }
        );
        
        if (!response.ok) {
          const errorText = await response.text();
          return {
            status: 400,
            jsonBody: {
              error: "Error al enviar mensaje a WhatsApp",
              apiError: errorText
            }
          };
        }
        
        const result = await response.json();
        
        // Registrar mensaje enviado en logs
        this.logMessageSent(integration.agentId, integrationId, to, type, result.messages[0].id);
        
        return {
          status: 200,
          jsonBody: {
            success: true,
            messageId: result.messages[0].id,
            to,
            type
          }
        };
      } catch (error) {
        return {
          status: 500,
          jsonBody: {
            error: "Error al enviar mensaje a WhatsApp",
            details: error instanceof Error ? error.message : String(error)
          }
        };
      }
    } catch (error) {
      this.logger.error("Error al enviar mensaje de WhatsApp:", error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al enviar mensaje: ${errorMessage}` }
      };
    }
  }
  
  async processWebhook(webhookData: any): Promise<void> {
    try {
      // Verificar si es un mensaje entrante
      if (!webhookData.entry || !webhookData.entry[0] || !webhookData.entry[0].changes) {
        return;
      }
      
      const changes = webhookData.entry[0].changes;
      
      for (const change of changes) {
        if (change.field !== 'messages') continue;
        
        const value = change.value;
        if (!value || !value.messages || !value.messages.length) continue;
        
        const phoneNumberId = value.metadata.phone_number_id;
        
        // Buscar la integración asociada a este phoneNumberId
        const integration = await this.findIntegrationByPhoneNumberId(phoneNumberId);
        
        if (!integration) {
          this.logger.warn(`No se encontró integración para phoneNumberId: ${phoneNumberId}`);
          continue;
        }
        
        // Procesar cada mensaje
        for (const message of value.messages) {
          await this.processIncomingMessage(integration, message, value.contacts[0]);
        }
      }
    } catch (error) {
      this.logger.error("Error al procesar webhook de WhatsApp:", error);
    }
  }
  
  async updateIntegration(integrationId: string, data: any, userId: string): Promise<HttpResponseInit> {
    try {
      // Verificar si la integración existe
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        return {
          status: 404,
          jsonBody: { error: "Integración no encontrada" }
        };
      }
      
      // Verificar acceso
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return {
          status: 403,
          jsonBody: { error: "No tienes permiso para modificar esta integración" }
        };
      }
      
      // Actualizar configuración
      const config = integration.config as IntegrationWhatsAppConfig;
      const updatedConfig: IntegrationWhatsAppConfig = {
        ...config,
        displayName: data.displayName || config.displayName,
        webhookVerifyToken: data.webhookVerifyToken || config.webhookVerifyToken,
        accessToken: data.accessToken || config.accessToken,
        messagingLimit: data.messagingLimit || config.messagingLimit
      };
      
      // Preparar datos para actualización
      const updateData: any = {
        partitionKey: integration.agentId,
        rowKey: integrationId,
        config: updatedConfig,
        updatedAt: Date.now()
      };
      
      // Si se proporciona un nuevo nombre
      if (data.name) {
        updateData.name = data.name;
      }
      
      // Si se proporciona nueva descripción
      if (data.description) {
        updateData.description = data.description;
      }
      
      // Si se proporciona nuevo token
      if (data.accessToken) {
        updateData.credentials = data.accessToken; // En producción, encriptar
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
          message: "Integración de WhatsApp actualizada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar integración de WhatsApp ${integrationId}:`, error);
      
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        status: 500,
        jsonBody: { error: `Error al actualizar integración: ${errorMessage}` }
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
  
  private async findIntegrationByPhoneNumberId(phoneNumberId: string): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      // Buscar integraciones de WhatsApp
      const integrations = tableClient.listEntities({
        queryOptions: { 
          filter: `provider eq 'whatsapp' and isActive eq true` 
        }
      });
      
      for await (const integration of integrations) {
        const config = typeof integration.config === 'string' 
          ? JSON.parse(integration.config) 
          : integration.config;
        
        if (config.phoneNumberId === phoneNumberId) {
          return integration as unknown as Integration;
        }
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al buscar integración por phoneNumberId ${phoneNumberId}:`, error);
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
  
  private async updateIntegrationStatus(integrationId: string, agentId: string, status: IntegrationStatus): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      await tableClient.updateEntity({
        partitionKey: agentId,
        rowKey: integrationId,
        status,
        updatedAt: Date.now()
      }, "Merge");
    } catch (error) {
      this.logger.error(`Error al actualizar estado de integración ${integrationId}:`, error);
    }
  }
  
  private async logMessageSent(agentId: string, integrationId: string, to: string, type: string, messageId: string): Promise<void> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATION_LOGS);
      
      const logId = uuidv4();
      const now = Date.now();
      
      await tableClient.createEntity({
        partitionKey: agentId,
        rowKey: logId,
        integrationId,
        action: 'message_sent',
        recipient: to,
        messageType: type,
        messageId,
        timestamp: now
      });
    } catch (error) {
      this.logger.error(`Error al registrar mensaje enviado:`, error);
    }
  }
  
  private async processIncomingMessage(integration: Integration, message: any, contact: any): Promise<void> {
    try {
      const agentId = integration.agentId;
      const messageText = message.text?.body || '';
      const from = message.from;
      const fromName = contact.profile?.name || '';
      
      // Aquí implementaríamos la lógica para convertir el mensaje de WhatsApp 
      // a un mensaje interno para el bot y encolarlo para procesamiento
      
      // Por ejemplo:
      const queueClient = this.storageService.getQueueClient(STORAGE_QUEUES.CONVERSATION);
      
      const messageRequest = {
        agentId,
        content: messageText,
        messageType: 'text',
        sourceChannel: 'whatsapp',
        metadata: {
          whatsapp: {
            from,
            fromName,
            messageId: message.id,
            timestamp: message.timestamp,
            integrationId: integration.id
          }
        }
      };
      
      // Encolar para procesamiento
      await queueClient.sendMessage(Buffer.from(JSON.stringify(messageRequest)).toString('base64'));
      
      this.logger.info(`Mensaje de WhatsApp encolado para procesamiento: ${message.id}`);
    } catch (error) {
      this.logger.error(`Error al procesar mensaje entrante de WhatsApp:`, error);
    }
  }
}