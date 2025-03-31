// src/shared/validators/conversation/conversationSearchValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { Logger, createLogger } from "../../utils/logger";
import { ConversationStatus } from "../../models/conversation.model";

export interface ConversationSearchParams {
  agentId?: string;
  query?: string;
  status?: ConversationStatus;
  startDate?: number;
  endDate?: number;
  limit?: number;
  skip?: number;
}

export class ConversationSearchValidator {
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
  }
  
  validate(data: ConversationSearchParams): ValidationResult {
    const errors: string[] = [];
    
    // Se debe proporcionar al menos un criterio de búsqueda
    if (!data.agentId && !data.query && !data.status && !data.startDate && !data.endDate) {
      errors.push("Se debe proporcionar al menos un criterio de búsqueda");
    }
    
    // Validar query (si se proporciona)
    if (data.query !== undefined && typeof data.query !== 'string') {
      errors.push("query debe ser una cadena de texto");
    } else if (data.query && data.query.length > 100) {
      errors.push("La consulta no puede exceder los 100 caracteres");
    }
    
    // Validar status (si se proporciona)
    if (data.status !== undefined && 
        ![ConversationStatus.ACTIVE, ConversationStatus.ENDED, ConversationStatus.TRANSFERRED, ConversationStatus.ABANDONED].includes(data.status)) {
      errors.push(`Estado inválido. Valores permitidos: ${Object.values(ConversationStatus).join(', ')}`);
    }
    
    // Validar rango de fechas (si se proporciona)
    if (data.startDate !== undefined && typeof data.startDate !== 'number') {
      errors.push("startDate debe ser un timestamp numérico");
    }
    
    if (data.endDate !== undefined && typeof data.endDate !== 'number') {
      errors.push("endDate debe ser un timestamp numérico");
    }
    
    if (data.startDate && data.endDate && data.startDate > data.endDate) {
      errors.push("La fecha de inicio no puede ser posterior a la fecha de fin");
    }
    
    // Validar limit y skip (si se proporcionan)
    if (data.limit !== undefined) {
      if (typeof data.limit !== 'number') {
        errors.push("limit debe ser un número");
      } else if (data.limit < 1) {
        errors.push("limit debe ser al menos 1");
      } else if (data.limit > 100) {
        errors.push("limit no puede exceder 100");
      }
    }
    
    if (data.skip !== undefined) {
      if (typeof data.skip !== 'number') {
        errors.push("skip debe ser un número");
      } else if (data.skip < 0) {
        errors.push("skip no puede ser negativo");
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}