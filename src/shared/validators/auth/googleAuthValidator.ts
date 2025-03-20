// src/shared/validators/auth/googleAuthValidator.ts
import { ValidationResult } from "../../models/validation.model";

export class GoogleAuthValidator {
  validate(data: any): ValidationResult {
    const errors: string[] = [];
    
    // Validar token de Google
    if (!data.googleToken) {
      errors.push("Token de Google requerido");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}