// src/shared/validators/agents/agentRolesValidator.ts
import { ValidationResult } from "../../models/validation.model";
import { StorageService } from "../../services/storage.service";
import { STORAGE_TABLES } from "../../constants";
import { Logger, createLogger } from "../../utils/logger";
import { RoleType } from "../../models/userRole.model";

export class AgentRolesValidator {
  private storageService: StorageService;
  private logger: Logger;
  
  constructor(logger?: Logger) {
    this.storageService = new StorageService();
    this.logger = logger || createLogger();
  }
  
  async validate(agentId: string, userId: string, data: any): Promise<ValidationResult> {
    const errors: string[] = [];
    
    // Validar email
    if (!data.targetEmail) {
      errors.push("Email del usuario objetivo es requerido");
    } else if (!this.isValidEmail(data.targetEmail)) {
      errors.push("Email del usuario objetivo no es válido");
    }
    
    // Validar rol
    if (!data.role) {
      errors.push("Rol es requerido");
    } else {
      const validRoles = Object.values(RoleType);
      if (!validRoles.includes(data.role)) {
        errors.push(`Rol no válido. Valores permitidos: ${validRoles.join(', ')}`);
      }
    }
    
    // Validar que no se intente asignar rol de propietario
    if (data.role === RoleType.OWNER) {
      errors.push("No se puede asignar el rol de propietario");
    }
    
    // Verificar que el usuario actual tenga permisos para gestionar roles
    if (errors.length === 0) {
      const hasPermission = await this.userCanManageRoles(agentId, userId);
      if (!hasPermission) {
        errors.push("No tienes permiso para gestionar roles en este agente");
      }
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
  
  private async userCanManageRoles(agentId: string, userId: string): Promise<boolean> {
    try {
      // Verificar si el usuario es el propietario del agente
      const agentsTable = this.storageService.getTableClient(STORAGE_TABLES.AGENTS);
      
      try {
        const agent = await agentsTable.getEntity('agent', agentId);
        if (agent.userId === userId) {
          return true;
        }
      } catch (error) {
        this.logger.warn(`Agente ${agentId} no encontrado:`, error);
        return false;
      }
      
      // Verificar si el usuario tiene rol de administrador
      const rolesTable = this.storageService.getTableClient(STORAGE_TABLES.USER_ROLES);
      const roles = rolesTable.listEntities({
        queryOptions: { 
          filter: `agentId eq '${agentId}' and userId eq '${userId}' and role eq '${RoleType.ADMIN}' and isActive eq true` 
        }
      });
      
      for await (const role of roles) {
        return true;
      }
      
      return false;
    } catch (error) {
      this.logger.error(`Error al verificar permisos para gestionar roles:`, error);
      return false;
    }
  }
}