// src/shared/validators/integrations/whatsAppIntegrationValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";

export class WhatsAppIntegrationValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validateConfig(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos requeridos
    if (!data.agentId) {
      errors.push("ID del agente es requerido");
    }
    
    if (!data.phoneNumberId) {
      errors.push("ID del número de teléfono es requerido");
    }
    
    if (!data.businessAccountId) {
      errors.push("ID de la cuenta de negocio es requerido");
    }
    
    if (!data.accessToken) {
      errors.push("Token de acceso es requerido");
    }
    
    if (!data.phoneNumber) {
      errors.push("Número de teléfono es requerido");
    } else if (!this.isValidPhoneNumber(data.phoneNumber)) {
      errors.push("Formato de número de teléfono inválido");
    }
    
    // Verificar acceso al agente si no hay errores
    if (errors.length === 0 && data.agentId) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para configurar este agente");
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateMessage(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos requeridos
    if (!data.integrationId) {
      errors.push("ID de integración es requerido");
    }
    
    if (!data.to) {
      errors.push("Destinatario (to) es requerido");
    } else if (!this.isValidPhoneNumber(data.to)) {
      errors.push("Formato de número de destinatario inválido");
    }
    
    if (!data.type) {
      errors.push("Tipo de mensaje es requerido");
    } else if (!['text', 'template', 'image', 'document', 'audio', 'video'].includes(data.type)) {
      errors.push("Tipo de mensaje inválido");
    }
    
    // Validar contenido según tipo
    if (data.type === 'text' && (!data.text || !data.text.body)) {
      errors.push("Contenido de texto es requerido");
    }
    
    if (data.type === 'template' && (!data.template || !data.template.name)) {
      errors.push("Nombre de plantilla es requerido");
    }
    
    // Verificar acceso a la integración si no hay errores
    if (errors.length === 0 && data.integrationId) {
      const hasAccess = await this.verifyIntegrationAccess(data.integrationId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para usar esta integración");
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  private isValidPhoneNumber(phone: string): boolean {
    // Formato básico internacional: +[código de país][número]
    const regex = /^\+[1-9]\d{1,14}$/;
    return regex.test(phone);
  }
  
  private async verifyAgentAccess(agentId: string, userId: string): Promise<boolean> {
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
  
  private async verifyIntegrationAccess(integrationId: string, userId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      // Buscar la integración
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      
      for await (const integration of integrations) {
        const agentId = integration.agentId as string;
        
        // Verificar acceso al agente asociado
        return await this.verifyAgentAccess(agentId, userId);
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar acceso a integración ${integrationId}:`, error);
      return false;
    }
  }
}