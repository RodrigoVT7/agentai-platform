// src/shared/validators/conversation/feedbackProcessorValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { Logger, createLogger } from "../../utils/logger";
import { FeedbackRating } from "../../models/conversation.model";

export class FeedbackProcessorValidator {
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.logger = logger || createLogger();
  }
  
  validate(data: any): ValidationResult {
    const errors: string[] = [];
    
    // Validar rating
    if (data.rating === undefined) {
      errors.push("Se requiere una valoración (rating)");
    } else if (![FeedbackRating.POSITIVE, FeedbackRating.NEUTRAL, FeedbackRating.NEGATIVE].includes(data.rating)) {
      errors.push(`Valoración inválida. Valores permitidos: ${FeedbackRating.POSITIVE}, ${FeedbackRating.NEUTRAL}, ${FeedbackRating.NEGATIVE}`);
    }
    
    // Validar isHelpful (opcional)
    if (data.isHelpful !== undefined && typeof data.isHelpful !== 'boolean') {
      errors.push("isHelpful debe ser un valor booleano");
    }
    
    // Validar comment (opcional)
    if (data.comment !== undefined && typeof data.comment !== 'string') {
      errors.push("comment debe ser una cadena de texto");
    } else if (data.comment && data.comment.length > 1000) {
      errors.push("El comentario no puede exceder los 1000 caracteres");
    }
    
    // Validar category (opcional)
    if (data.category !== undefined && typeof data.category !== 'string') {
      errors.push("category debe ser una cadena de texto");
    } else if (data.category && data.category.length > 50) {
      errors.push("La categoría no puede exceder los 50 caracteres");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}