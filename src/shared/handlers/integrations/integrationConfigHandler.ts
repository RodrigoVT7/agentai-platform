// src/shared/handlers/integrations/integrationConfigHandler.ts
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { createAppError } from "../../utils/error.utils";
import { Integration, IntegrationStatus } from "../../models/integration.model";

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
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, "Error al obtener integración");
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
        // Excluir credenciales sensibles
        const { credentials, ...safeIntegration } = item as any;
        integrations.push(safeIntegration);
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
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, "Error al crear integración");
    }
  }
  
  async updateIntegration(integrationId: string, data: any, userId: string): Promise<any> {
    try {
      // Verificar si la integración existe
      const integration = await this.fetchIntegration(integrationId);
      
      if (!integration) {
        throw createAppError(404, "Integración no encontrada");
      }
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAccess(integration.agentId, userId);
      if (!hasAccess) {
        throw createAppError(403, "No tienes permiso para modificar esta integración");
      }
      
      // Preparar datos para actualización
      const now = Date.now();
      const updateData: any = {
        partitionKey: integration.agentId,
        rowKey: integrationId,
        updatedAt: now
      };
      
      // Actualizar campos proporcionados
      if (data.name !== undefined) updateData.name = data.name;
      if (data.description !== undefined) updateData.description = data.description;
      if (data.config !== undefined) updateData.config = data.config;
      if (data.status !== undefined) updateData.status = data.status;
      
      // Actualizar credenciales si están presentes
      if (data.credentials) {
        updateData.credentials = this.encryptCredentials(data.credentials);
      }
      
      // Actualizar en Table Storage
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      await tableClient.updateEntity(updateData, "Merge");
      
      // Obtener integración actualizada
      const updatedIntegration = await this.fetchIntegration(integrationId);
      
      // Excluir credenciales de la respuesta
      const { credentials: _, ...safeIntegration } = updatedIntegration as Integration;
      
      return {
        status: 200,
        jsonBody: {
          ...safeIntegration,
          message: "Integración actualizada con éxito"
        }
      };
    } catch (error) {
      this.logger.error(`Error al actualizar integración ${integrationId}:`, error);
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, "Error al actualizar integración");
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
      
      if (error && typeof error === 'object' && 'statusCode' in error) {
        throw error;
      }
      
      throw createAppError(500, "Error al eliminar integración");
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