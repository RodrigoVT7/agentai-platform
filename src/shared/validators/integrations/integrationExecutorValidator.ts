// src/shared/validators/integrations/integrationExecutorValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { IntegrationType, IntegrationStatus } from "../../models/integration.model";

export class IntegrationExecutorValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validate(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos requeridos
    if (!data.integrationId) {
      errors.push("ID de integración es requerido");
    }
    
    if (!data.action) {
      errors.push("Acción es requerida");
    }
    
    // Si hay errores básicos, no seguir validando
    if (errors.length > 0) {
      return {
        isValid: false,
        errors
      };
    }
    
    // Validar que la integración existe y está activa
    try {
      const integration = await this.getIntegration(data.integrationId);
      
      if (!integration) {
        errors.push(`Integración no encontrada: ${data.integrationId}`);
        return {
          isValid: false,
          errors
        };
      }
      
      // Verificar acceso al agente
      const hasAccess = await this.verifyAgentAccess(integration.agentId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para ejecutar esta integración");
        return {
          isValid: false,
          errors
        };
      }
      
      // Verificar estado de la integración
      if (integration.status !== IntegrationStatus.ACTIVE) {
        errors.push(`La integración no está activa (estado: ${integration.status})`);
      }
      
      // Validar que la acción es válida para el tipo de integración
      const validAction = await this.isValidAction(integration.type, integration.provider, data.action);
      if (!validAction) {
        errors.push(`Acción "${data.action}" no válida para integración de tipo ${integration.type}:${integration.provider}`);
      }
      
      // Validar parámetros según el tipo de acción
      const parametersValid = await this.validateActionParameters(
        integration.type, 
        integration.provider, 
        data.action, 
        data.parameters
      );
      
      if (!parametersValid.isValid) {
        errors.push(...(parametersValid.errors || []));
      }
    } catch (error) {
      this.logger.error("Error al validar integración:", error);
      errors.push("Error al validar integración");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  private async getIntegration(integrationId: string): Promise<any> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.INTEGRATIONS);
      
      // Buscar en todas las particiones
      const integrations = tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${integrationId}'` }
      });
      
      for await (const integration of integrations) {
        return integration;
      }
      
      return null;
    } catch (error) {
      this.logger.error(`Error al obtener integración ${integrationId}:`, error);
      return null;
    }
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
  
  private async isValidAction(type: string, provider: string, action: string): Promise<boolean> {
    // Mapa de acciones válidas por tipo de integración
    const validActions: Record<string, string[]> = {
      [`${IntegrationType.CALENDAR}:google`]: ['getEvents', 'createEvent', 'updateEvent', 'deleteEvent'],
      [`${IntegrationType.CALENDAR}:microsoft`]: ['getEvents', 'createEvent', 'updateEvent', 'deleteEvent'],
      [`${IntegrationType.MESSAGING}:whatsapp`]: ['sendMessage', 'sendTemplate'],
      [`${IntegrationType.EMAIL}:microsoft`]: ['sendEmail', 'getEmails'],
      [`${IntegrationType.ERP}:generic`]: ['queryData', 'createRecord', 'updateRecord', 'deleteRecord'],
      [`${IntegrationType.ERP}:sap`]: ['queryData', 'createRecord', 'updateRecord', 'deleteRecord'],
      [`${IntegrationType.ERP}:dynamics`]: ['queryData', 'createRecord', 'updateRecord', 'deleteRecord'],
      [`${IntegrationType.ERP}:odoo`]: ['queryData', 'createRecord', 'updateRecord', 'deleteRecord'],
    };
    
    // Verificar si la acción está en la lista de acciones válidas
    const key = `${type}:${provider}`;
    return validActions[key]?.includes(action) || false;
  }
  
  private async validateActionParameters(
    type: string, 
    provider: string, 
    action: string, 
    parameters: any
  ): Promise<ValidationResult> {
    if (!parameters) {
      return { 
        isValid: false, 
        errors: ["Parámetros requeridos"] 
      };
    }
    
    const errors: string[] = [];
    
    // Validar parámetros según tipo de integración y acción
    switch (`${type}:${action}`) {
      case `${IntegrationType.CALENDAR}:createEvent`:
        if (!parameters.summary) {
          errors.push("El título del evento (summary) es requerido");
        }
        if (!parameters.start) {
          errors.push("La fecha de inicio (start) es requerida");
        }
        if (!parameters.end) {
          errors.push("La fecha de fin (end) es requerida");
        }
        break;
        
      case `${IntegrationType.CALENDAR}:updateEvent`:
        if (!parameters.eventId) {
          errors.push("ID del evento es requerido");
        }
        break;
        
      case `${IntegrationType.CALENDAR}:deleteEvent`:
        if (!parameters.eventId) {
          errors.push("ID del evento es requerido");
        }
        break;
        
      case `${IntegrationType.MESSAGING}:sendMessage`:
        if (!parameters.to) {
          errors.push("Destinatario (to) es requerido");
        }
        if (!parameters.content) {
          errors.push("Contenido del mensaje es requerido");
        }
        break;
        
      case `${IntegrationType.EMAIL}:sendEmail`:
        if (!parameters.to) {
          errors.push("Destinatario (to) es requerido");
        }
        if (!parameters.subject) {
          errors.push("Asunto del email es requerido");
        }
        if (!parameters.body) {
          errors.push("Cuerpo del email es requerido");
        }
        break;
        
      case `${IntegrationType.ERP}:queryData`:
        if (!parameters.entity && !parameters.query) {
          errors.push("Entidad o consulta es requerida");
        }
        break;
        
      case `${IntegrationType.ERP}:createRecord`:
        if (!parameters.entity) {
          errors.push("Entidad es requerida");
        }
        if (!parameters.data) {
          errors.push("Datos para crear registro son requeridos");
        }
        break;
        
      case `${IntegrationType.ERP}:updateRecord`:
        if (!parameters.entity) {
          errors.push("Entidad es requerida");
        }
        if (!parameters.recordId) {
          errors.push("ID del registro es requerido");
        }
        if (!parameters.data) {
          errors.push("Datos para actualizar registro son requeridos");
        }
        break;
        
      case `${IntegrationType.ERP}:deleteRecord`:
        if (!parameters.entity) {
          errors.push("Entidad es requerida");
        }
        if (!parameters.recordId) {
          errors.push("ID del registro es requerido");
        }
        break;
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}