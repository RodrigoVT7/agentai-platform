// src/shared/validators/auth/userProfileUpdateValidator.ts
import { ValidationResult } from "../../models/validation.model";

export class UserProfileUpdateValidator {
  validate(data: any): ValidationResult {
    const errors: string[] = [];
    
    // Validar campos opcionales
    if (data.firstName !== undefined && (!data.firstName || data.firstName.trim() === '')) {
      errors.push('Nombre no puede estar vacío');
    }
    
    if (data.lastName !== undefined && data.lastName.trim() === '') {
      errors.push('Apellido no puede estar vacío');
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
}