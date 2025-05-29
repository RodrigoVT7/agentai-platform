// src/shared/handlers/integrations/integrationConfigHandler.ts
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError, toAppError } from "../../utils/error.utils";
import {
  Integration,
  IntegrationStatus,
  IntegrationType, // Asegúrate de que IntegrationType esté importado
  IntegrationGoogleCalendarConfig // Importa la config específica
} from "../../models/integration.model";
import { HttpResponseInit } from "@azure/functions"; // Importa HttpResponseInit
export class IntegrationConfigHandler {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async getIntegration(integrationId: string, userId: string): Promise<any> {
    try {
      // Verificar si la integración existe y el usuario tiene acceso
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        throw createAppError(404, "Integración no encontrada");
      }
      
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para acceder a esta integración");
      }
      
      // No devolver credenciales sensibles
      const { credentials, ...safeIntegration } = integration;
      
      return {
        status: 200,
        jsonBody: safeIntegration
      };
    } catch (error) {
      this.logger.error(`Error al obtener integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }
  
  async listIntegrations(agentId: string, userId: string): Promise<any> {
    try {
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para acceder a este agente");
      }
      
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      const integrations: Partial<Integration>[] = [];
      const items = tableClient.listEntities({
        queryOptions: { filter: `PartitionKey eq '${agentId}' and isActive eq true` }
      });
      
      for await (const item of items) {
        const { credentials, config: rawConfig, ...safeItem } = item as any;
        let parsedConfig = {};
        if (typeof rawConfig === 'string') {
            try { parsedConfig = JSON.parse(rawConfig); } catch { /* ignore */ }
        } else if (typeof rawConfig === 'object' && rawConfig !== null) {
            parsedConfig = rawConfig;
        }
        integrations.push({...safeItem, config: parsedConfig });
      }
      
      return {
        status: 200,
        jsonBody: {
          agentId,
          integrations
        }
      };
    } catch (error) {
      this.logger.error(`Error al listar integraciones para el agente ${agentId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, "Error al listar integraciones");
    }
  }
  
  async createIntegration(data: any, userId: string): Promise<any> {
    try {
      const { agentId, name, description, type, provider, config, credentials } = data;
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para modificar este agente");
      }
      
      // Generar ID para la integración
      const integrationId = uuidv4();
      const now = Date.now();
      
      // Encriptar credenciales si están presentes
      const encryptedCredentials = credentials 
        ? this.encryptCredentials(credentials) 
        : '';
      
      // Crear nueva integración
      const integration: Integration = {
        id: integrationId,
        agentId,
        name,
        description: description || '',
        type,
        provider,
        config: config || {},
        credentials: encryptedCredentials,
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
      
      // Excluir credenciales de la respuesta
      const { credentials: _, ...safeIntegration } = integration;
      
      return {
        status: 201,
        jsonBody: {
          ...safeIntegration,
          message: "Integración creada con éxito"
        }
      };
    } catch (error) {
      this.logger.error("Error al crear integración:", error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }
  
  async updateIntegration(integrationId: string, data: any, userId: string): Promise<HttpResponseInit> {
    try {
      const integration = await this.fetchIntegration(integrationId);
      if (!integration) {
        return { status: 404, jsonBody: { error: "Integración no encontrada" } };
      }

      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        return { status: 403, jsonBody: { error: "No tienes permiso para modificar esta integración" } };
      }

      const now = Date.now();
      const updatePayload: any = {
        partitionKey: integration.agentId,
        rowKey: integrationId,
        updatedAt: now
      };

      let configUpdated = false;
      // Asegurarse de que integration.config es un objeto antes de intentar modificarlo
      let currentConfig = integration.config as any; // Ya debería ser objeto por fetchIntegration
      if (typeof currentConfig !== 'object' || currentConfig === null) currentConfig = {};


      // Manejo específico para configuración de Google Calendar
      if (integration.provider === 'google' && integration.type === IntegrationType.CALENDAR) {
        const googleConfig = currentConfig as IntegrationGoogleCalendarConfig;
        if (data.config?.maxConcurrentAppointments !== undefined) {
          const newMax = Number(data.config.maxConcurrentAppointments);
          if (!isNaN(newMax) && newMax >= 0) {
            googleConfig.maxConcurrentAppointments = newMax;
            configUpdated = true;
          } else {
            this.logger.warn(`Valor inválido para maxConcurrentAppointments: ${data.config.maxConcurrentAppointments}`);
          }
        }
        if (data.config?.calendarId !== undefined && data.config.calendarId !== googleConfig.calendarId) {
            googleConfig.calendarId = data.config.calendarId;
            configUpdated = true;
        }
        // Añadir otros campos de config de Google Calendar que quieras permitir actualizar
      } else if (data.config !== undefined) { // Para otras integraciones, reemplazar config si se provee
        currentConfig = {...currentConfig, ...data.config}; // Fusionar o reemplazar config general
        configUpdated = true;
      }


      if (configUpdated) {
        updatePayload.config = JSON.stringify(currentConfig);
      }

      if (data.name !== undefined) updatePayload.name = data.name;
      if (data.description !== undefined) updatePayload.description = data.description;
      if (data.status !== undefined) updatePayload.status = data.status;
      if (data.isActive !== undefined) updatePayload.isActive = data.isActive;

      if (data.credentials) {
        updatePayload.credentials = this.encryptCredentials(data.credentials);
      }

      if (Object.keys(updatePayload).length <= 3 && !configUpdated) { // Solo PK, RK, updatedAt
          return {status: 200, jsonBody: { message: "No se realizaron cambios.", id: integrationId }};
      }

      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity(updatePayload, "Merge");

      const updatedIntegrationEntity = await this.fetchIntegration(integrationId);
      if (!updatedIntegrationEntity) throw new Error("Error al re-obtener la integración actualizada."); // Seguridad

      const { credentials: _, config: rawUpdatedConfig, ...safeUpdatedIntegration } = updatedIntegrationEntity;
      
      return {
        status: 200,
        jsonBody: {
          ...safeUpdatedIntegration, // safeUpdatedIntegration ya tiene config como objeto
          message: "Integración actualizada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }
  
  async deleteIntegration(integrationId: string, userId: string): Promise<any> {
    try {
      // Verificar si la integración existe
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        throw createAppError(404, "Integración no encontrada");
      }
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para eliminar esta integración");
      }
      
      // Realizar eliminación lógica (no física)
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
          message: "Integración eliminada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al eliminar integración ${integrationId}:`, error);
      const appError = toAppError(error);
      return { status: appError.statusCode, jsonBody: { error: appError.message, details: appError.details } };
    }
  }
  
  // Métodos auxiliares
  
  private async fetchIntegration(integrationId: string): Promise<Integration | null> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      // Buscar en todas las particiones ya que no conocemos el agentId
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      
      for await (const entity of integrations) {
        if (typeof entity.config === 'string') {
            try {
                entity.config = JSON.parse(entity.config);
            } catch (e) {
                this.logger.warn(`Error parseando config JSON para integración ${integrationId}:`, e);
                entity.config = {};
            }
        } else if (entity.config === null || entity.config === undefined) {
            entity.config = {};
        }
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
  
  private encryptCredentials(credentials: any): string {
    try {
      // Obtener clave de encriptación
      const encryptionKey = process.env.ENCRYPTION_KEY;
      if (!encryptionKey) {
        throw new Error("ENCRYPTION_KEY no está configurada en variables de entorno");
      }
      
      // Convertir a JSON y encriptar
      const credentialsString = JSON.stringify(credentials);
      
      // Generar IV único
      const iv = crypto.randomBytes(16);
      
      // Crear clave a partir de la clave de encriptación
      const key = crypto.scryptSync(encryptionKey, 'salt', 32);
      
      // Crear cifrador
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      
      // Encriptar
      let encrypted = cipher.update(credentialsString, 'utf8', 'base64');
      encrypted += cipher.final('base64');
      
      // Devolver IV y datos encriptados
      return `${iv.toString('hex')}:${encrypted}`;
    } catch (error) {
      this.logger.error("Error al encriptar credenciales:", error);
      throw createAppError(500, "Error al encriptar credenciales");
    }
  }
}