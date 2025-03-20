// src/shared/validators/auth/userLoginValidator.ts
import { ValidationResult } from "../../models/validation.model";

export class UserLoginValidator {
  validate(data: any): ValidationResult {
    const errors: string[] = [];
    
    // Validar email
    if (!data.email || !this.isValidEmail(data.email)) {
      errors.push("Email inválido");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  private isValidEmail(email: string): boolean {
    const re = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return re.test(email);
  }
}