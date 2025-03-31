// src/shared/validators/conversation/messageReceiverValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { MessageRequest, MessageType } from "../../models/conversation.model";

export class MessageReceiverValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validate(data: MessageRequest): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar agentId
    if (!data.agentId) {
      errors.push("Se requiere el ID del agente");
    } else {
      // Verificar si el agente existe
      const agentExists = await this.checkAgentExists(data.agentId);
      if (!agentExists) {
        errors.push("El agente especificado no existe o está inactivo");
      }
    }
    
    // Validar conversationId si se proporciona
    if (data.conversationId) {
      const conversationExists = await this.checkConversationExists(data.conversationId, data.agentId);
      if (!conversationExists) {
        errors.push("La conversación especificada no existe o no pertenece al agente");
      }
    }
    
    // Validar contenido del mensaje
    if (!data.content || data.content.trim() === '') {
      errors.push("El contenido del mensaje no puede estar vacío");
    } else if (data.content.length > 4000) {
      errors.push("El contenido del mensaje no puede exceder los 4000 caracteres");
    }
    
    // Validar tipo de mensaje
    if (data.messageType && !Object.values(MessageType).includes(data.messageType)) {
      errors.push(`Tipo de mensaje no válido. Valores permitidos: ${Object.values(MessageType).join(', ')}`);
    }
    
    // Validar adjuntos si se proporcionan
    if (data.attachments && typeof data.attachments !== 'object') {
      errors.push("El formato de los adjuntos no es válido");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  private async checkAgentExists(agentId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      const agent = await tableClient.getEntity('agent', agentId);
      return agent.isActive === true;
    } catch (error) {
      this.logger.warn(`Error al verificar agente ${agentId}:`, error);
      return false;
    }
  }
  
  private async checkConversationExists(conversationId: string, agentId: string): Promise<boolean> {
    try {
      const tableClient = this.storageService.getTableClient(STORAGE_TABLES.CONVERSATIONS);
      const conversations = await tableClient.listEntities({
        queryOptions: { filter: `RowKey eq '${conversationId}' and agentId eq '${agentId}'` }
      });
      
      for await (const conversation of conversations) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.warn(`Error al verificar conversación ${conversationId}:`, error);
      return false;
    }
  }
}