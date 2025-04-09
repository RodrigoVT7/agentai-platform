// src/shared/validators/integrations/microsoftGraphValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";

export class MicrosoftGraphValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validateIntegration(data: any, userId: string): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos requeridos
    if (!data.agentId) {
      errors.push("ID del agente es requerido");
    }
    
    if (!data.accessToken) {
      errors.push("Token de acceso es requerido");
    }
    
    // Verificar acceso al agente si no hay errores en validación básica
    if (errors.length === 0 && data.agentId) {
      const hasAccess = await this.verifyAgentAccess(data.agentId, userId);
      if (!hasAccess) {
        errors.push("No tienes permiso para acceder a este agente");
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateEvent(eventData: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar datos básicos del evento
    if (!eventData.summary) {
      errors.push("El título del evento (summary) es requerido");
    }
    
    if (!eventData.start) {
      errors.push("La fecha de inicio (start) es requerida");
    } else if (!eventData.start.dateTime && !eventData.start.date) {
      errors.push("El formato de fecha de inicio es inválido");
    }
    
    if (!eventData.end) {
      errors.push("La fecha de fin (end) es requerida");
    } else if (!eventData.end.dateTime && !eventData.end.date) {
      errors.push("El formato de fecha de fin es inválido");
    }
    
    // Validar fechas coherentes si ambas están presentes
    if (eventData.start && eventData.end) {
      // Comparar fechas según formato (dateTime o date)
      if (eventData.start.dateTime && eventData.end.dateTime) {
        const startDate = new Date(eventData.start.dateTime);
        const endDate = new Date(eventData.end.dateTime);
        
        if (startDate > endDate) {
          errors.push("La fecha de inicio no puede ser posterior a la fecha de fin");
        }
      } else if (eventData.start.date && eventData.end.date) {
        const startDate = new Date(eventData.start.date);
        const endDate = new Date(eventData.end.date);
        
        if (startDate > endDate) {
          errors.push("La fecha de inicio no puede ser posterior a la fecha de fin");
        }
      }
    }
    
    // Validar formato de asistentes
    if (eventData.attendees && !Array.isArray(eventData.attendees)) {
      errors.push("El formato de asistentes es inválido, debe ser un array");
    } else if (eventData.attendees && Array.isArray(eventData.attendees)) {
      // Validar cada asistente
      for (const attendee of eventData.attendees) {
        if (!attendee.emailAddress || !attendee.emailAddress.address) {
          errors.push("Todos los asistentes deben tener un email");
        }
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateMail(mailData: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar campos básicos del email
    if (!mailData.to) {
      errors.push("El destinatario (to) es requerido");
    }
    
    if (!mailData.subject) {
      errors.push("El asunto (subject) es requerido");
    }
    
    if (!mailData.body) {
      errors.push("El cuerpo del email (body) es requerido");
    }
    
    // Validar formato de destinatarios
    if (mailData.to && Array.isArray(mailData.to)) {
      for (const email of mailData.to) {
        if (!this.isValidEmail(email)) {
          errors.push(`Email inválido: ${email}`);
        }
      }
    } else if (mailData.to && !this.isValidEmail(mailData.to)) {
      errors.push(`Email inválido: ${mailData.to}`);
    }
    
    // Validar CC si está presente
    if (mailData.cc) {
      if (Array.isArray(mailData.cc)) {
        for (const email of mailData.cc) {
          if (!this.isValidEmail(email)) {
            errors.push(`Email CC inválido: ${email}`);
          }
        }
      } else if (!this.isValidEmail(mailData.cc)) {
        errors.push(`Email CC inválido: ${mailData.cc}`);
      }
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  async validateUpdate(updateData: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar que hay al menos un campo para actualizar
    if (!updateData || Object.keys(updateData).length === 0) {
      errors.push("No hay datos para actualizar");
    }
    
    // Si se actualizan credenciales, validar formato
    if (updateData.accessToken && !updateData.expiresAt) {
      errors.push("Se requiere expiresAt cuando se actualiza accessToken");
    }
    
    return {
      isValid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }
  
  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
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
}