// src/shared/validators/auth/tokenRefreshValidator.ts
import { ValidationResult } from "../../models/validation.model";

export class TokenRefreshValidator {
  validate(data: any): ValidationResult {
    const errors: string[] = [];
    
    // Validar token de refresco
    if (!data.refreshToken) {
      errors.push("Token de refresco requerido");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}